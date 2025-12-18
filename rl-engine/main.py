from __future__ import annotations

import json
import os
import random
import time
from typing import Dict, List, Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

STATE_FILE = os.getenv("POLICY_STATE_FILE", "policy_state.json")

DEFAULT_EPS = float(os.getenv("EPSILON", "0.2"))
DEFAULT_LR = float(os.getenv("LEARNING_RATE", "0.05"))

app = FastAPI(title="RL Engine (Prototype)", version="0.1.0")


def _load_state() -> Dict[str, Any]:
    if not os.path.exists(STATE_FILE):
        return {"actions": {}, "meta": {"epsilon": DEFAULT_EPS, "lr": DEFAULT_LR, "updates": 0}}
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"actions": {}, "meta": {"epsilon": DEFAULT_EPS, "lr": DEFAULT_LR, "updates": 0}}


def _save_state(state: Dict[str, Any]) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def _feature_items(features: Dict[str, Any]) -> List[tuple[str, float]]:
    items = []
    for k, v in (features or {}).items():
        try:
            items.append((k, float(v)))
        except Exception:
            continue
    # stable order
    items.sort(key=lambda x: x[0])
    return items


def _ensure_action(state: Dict[str, Any], action_id: str, feature_keys: List[str]) -> None:
    actions = state.setdefault("actions", {})
    if action_id not in actions:
        actions[action_id] = {"weights": {k: 0.0 for k in feature_keys}, "count": 0}
    else:
        # Add new keys if needed
        w = actions[action_id].setdefault("weights", {})
        for k in feature_keys:
            w.setdefault(k, 0.0)


def _score_action(action_weights: Dict[str, float], features: Dict[str, float]) -> float:
    s = 0.0
    for k, v in features.items():
        s += float(action_weights.get(k, 0.0)) * float(v)
    return s


class ActRequest(BaseModel):
    state: Dict[str, Any] = Field(default_factory=dict)
    actions: List[str] = Field(default_factory=list)


class ActResponse(BaseModel):
    action_id: str
    params: Dict[str, Any] = Field(default_factory=dict)
    meta: Dict[str, Any] = Field(default_factory=dict)


class LearnRequest(BaseModel):
    state: Dict[str, Any] = Field(default_factory=dict)
    action_id: str
    reward: float


@app.get("/health")
def health():
    return {"ok": True, "time": time.time()}


@app.post("/rl/act", response_model=ActResponse)
def rl_act(req: ActRequest):
    state = _load_state()
    meta = state.setdefault("meta", {"epsilon": DEFAULT_EPS, "lr": DEFAULT_LR, "updates": 0})
    eps = float(meta.get("epsilon", DEFAULT_EPS))

    features_items = _feature_items((req.state or {}).get("features", {}))
    features = {k: v for k, v in features_items}
    keys = [k for k, _ in features_items]

    candidates = req.actions or []
    if not candidates:
        return ActResponse(action_id="tighten_inbound_rule", meta={"reason": "no-actions"})

    for a in candidates:
        _ensure_action(state, a, keys)

    # epsilon-greedy
    explore = random.random() < eps
    if explore:
        chosen = random.choice(candidates)
        reason = "explore"
        scores = {}
    else:
        scores = {a: _score_action(state["actions"][a]["weights"], features) for a in candidates}
        chosen = max(scores, key=scores.get)
        reason = "exploit"

    _save_state(state)
    return ActResponse(
        action_id=chosen,
        params={},
        meta={"epsilon": eps, "mode": reason, "scores": scores}
    )


@app.post("/rl/learn")
def rl_learn(req: LearnRequest):
    state = _load_state()
    meta = state.setdefault("meta", {"epsilon": DEFAULT_EPS, "lr": DEFAULT_LR, "updates": 0})
    lr = float(meta.get("lr", DEFAULT_LR))

    features_items = _feature_items((req.state or {}).get("features", {}))
    features = {k: v for k, v in features_items}
    keys = [k for k, _ in features_items]

    _ensure_action(state, req.action_id, keys)
    a = state["actions"][req.action_id]
    w = a["weights"]

    # Simple linear bandit update: w += lr * reward * feature
    reward = float(req.reward)
    for k, v in features.items():
        w[k] = float(w.get(k, 0.0)) + (lr * reward * float(v))

    a["count"] = int(a.get("count", 0)) + 1
    meta["updates"] = int(meta.get("updates", 0)) + 1

    _save_state(state)
    return {"ok": True, "action_id": req.action_id, "reward": reward, "updates": meta["updates"]}

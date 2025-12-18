package zt

default allow = {"allowed": false, "reason": "default-deny"}

# Expected query: POST /v1/data/zt/allow with body {"input": {...}}
# input.action.id: string
# input.action.params: object
# input.context.environment: sandbox|prod

# Allow list (base) for sandbox
allowed_action_ids := {
  "tighten_inbound_rule",
  "remove_iam_permission",
  "enforce_mfa",
  "rotate_key",
  "apply_segmentation",
  "reduce_token_ttl",
  "quarantine_workload"
}

# Deny any unknown action
deny[msg] {
  not allowed_action_ids[input.action.id]
  msg := sprintf("unknown action: %v", [input.action.id])
}

# Deny quarantine in prod without explicit approval
deny[msg] {
  input.action.id == "quarantine_workload"
  input.context.environment == "prod"
  msg := "quarantine requires explicit human approval in prod"
}

# Deny tightening inbound if it would still allow 0.0.0.0/0
deny[msg] {
  input.action.id == "tighten_inbound_rule"
  cidr := object.get(input.action.params, "new_cidr", "")
  cidr == "0.0.0.0/0"
  msg := "inbound rule must not allow 0.0.0.0/0"
}

# Deny removing IAM permission if principal is break-glass
deny[msg] {
  input.action.id == "remove_iam_permission"
  principal := object.get(input.context.resource, "principal", "")
  principal == "breakglass-admin"
  msg := "cannot modify break-glass principal"
}

allow = {"allowed": true, "reason": "policy-allow"} {
  count(deny) == 0
}

allow = {"allowed": false, "reason": reason} {
  count(deny) > 0
  reason := concat("; ", [m | deny[m]])
}

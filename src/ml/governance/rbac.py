from dataclasses import dataclass
from enum import Enum
from typing import Dict, Set


class GovernanceRole(str, Enum):
    VIEWER = "viewer"
    ANALYST = "analyst"
    PLANNER = "planner"
    APPROVER = "approver"
    ADMIN = "admin"


class GovernanceAction(str, Enum):
    VIEW_AUDIT = "view_audit"
    REQUEST_APPROVAL = "request_approval"
    APPROVE_PLAN = "approve_plan"
    PROMOTE_MODEL = "promote_model"
    SWITCH_SOLVER_ENGINE = "switch_solver_engine"
    ENABLE_AUTOMATION_FLAGS = "enable_automation_flags"
    COMMIT_PLAN = "commit_plan"


@dataclass(frozen=True)
class ActorContext:
    actor_id: str
    role: GovernanceRole


class AuthorizationError(PermissionError):
    def __init__(self, *, action: GovernanceAction, role: GovernanceRole, allowed_roles: Set[GovernanceRole]):
        allowed = ", ".join(sorted(r.value for r in allowed_roles))
        super().__init__(
            f"Role '{role.value}' is not authorized for action '{action.value}'. "
            f"Allowed roles: {allowed}."
        )
        self.action = action
        self.role = role
        self.allowed_roles = allowed_roles


_ACTION_ROLES: Dict[GovernanceAction, Set[GovernanceRole]] = {
    GovernanceAction.VIEW_AUDIT: {
        GovernanceRole.VIEWER,
        GovernanceRole.ANALYST,
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.REQUEST_APPROVAL: {
        GovernanceRole.ANALYST,
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.APPROVE_PLAN: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.PROMOTE_MODEL: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.SWITCH_SOLVER_ENGINE: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.ENABLE_AUTOMATION_FLAGS: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.COMMIT_PLAN: {
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
}


def normalize_role(raw_role: str | None) -> GovernanceRole:
    value = str(raw_role or "").strip().lower()
    try:
        return GovernanceRole(value)
    except ValueError:
        return GovernanceRole.VIEWER


def ensure_role_allowed(actor_role: GovernanceRole, action: GovernanceAction) -> None:
    allowed_roles = _ACTION_ROLES.get(action, set())
    if actor_role not in allowed_roles:
        raise AuthorizationError(action=action, role=actor_role, allowed_roles=allowed_roles)


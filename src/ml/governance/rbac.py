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
    # V2 enterprise actions (synced with frontend ACTIONS)
    RUN_PLAN = "run_plan"
    RUN_WHATIF = "run_whatif"
    RUN_FORECAST = "run_forecast"
    EDIT_FORECAST_SETTINGS = "edit_forecast_settings"
    RUN_RISK_WORKFLOW = "run_risk_workflow"
    APPROVE_RISK_TRIGGER = "approve_risk_trigger"
    SET_CLOSED_LOOP_MODE = "set_closed_loop_mode"
    UPLOAD_DATA = "upload_data"
    MANAGE_MASTER_DATA = "manage_master_data"
    MANAGE_USERS = "manage_users"
    VIEW_SETTINGS = "view_settings"
    MANAGE_LOGIC_CONTROL = "manage_logic_control"
    DELETE_RUN = "delete_run"


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
    # V1 governance actions
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
    # V2 enterprise actions (synced with frontend usePermissions.jsx)
    GovernanceAction.RUN_PLAN: {
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.RUN_WHATIF: {
        GovernanceRole.ANALYST,
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.RUN_FORECAST: {
        GovernanceRole.ANALYST,
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.EDIT_FORECAST_SETTINGS: {
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.RUN_RISK_WORKFLOW: {
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.APPROVE_RISK_TRIGGER: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.SET_CLOSED_LOOP_MODE: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.UPLOAD_DATA: {
        GovernanceRole.PLANNER,
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.MANAGE_MASTER_DATA: {
        GovernanceRole.ADMIN,
    },
    GovernanceAction.MANAGE_USERS: {
        GovernanceRole.ADMIN,
    },
    GovernanceAction.VIEW_SETTINGS: {
        GovernanceRole.ADMIN,
    },
    GovernanceAction.MANAGE_LOGIC_CONTROL: {
        GovernanceRole.APPROVER,
        GovernanceRole.ADMIN,
    },
    GovernanceAction.DELETE_RUN: {
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

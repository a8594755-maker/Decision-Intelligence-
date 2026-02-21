"""
Governance primitives for RBAC, approvals, and immutable audit events.
"""

from .rbac import (
    GovernanceAction,
    GovernanceRole,
    ActorContext,
    AuthorizationError,
    ensure_role_allowed,
    normalize_role,
)
from .store import (
    ApprovalError,
    ApprovalStatus,
    GovernanceStore,
    canonical_payload_hash,
)

__all__ = [
    "GovernanceAction",
    "GovernanceRole",
    "ActorContext",
    "AuthorizationError",
    "ensure_role_allowed",
    "normalize_role",
    "ApprovalError",
    "ApprovalStatus",
    "GovernanceStore",
    "canonical_payload_hash",
]


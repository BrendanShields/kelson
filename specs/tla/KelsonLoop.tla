---------------------------- MODULE KelsonLoop ----------------------------
(* PRD §9.2 proposal state machine. Scope: per-proposal state transitions   *)
(* and the I2 monitoring bound. I1 (gate soundness) holds by construction   *)
(* of the transition relation — Apply is enabled only from "approved" — and *)
(* is additionally checked as a trace invariant. I4/I5 concern data the     *)
(* implementation owns (diff targets, changelog) and are discharged by      *)
(* LOOP-4/PACK-5 obligation tests, not this model.                          *)
EXTENDS Naturals, FiniteSets

CONSTANTS Proposals, K

VARIABLES state, everApproved

vars == <<state, everApproved>>

States == {"none", "proposed", "gated", "approved", "rejected", "applied",
           "monitoring", "stable", "reverted", "quarantined"}

TypeOK == /\ state \in [Proposals -> States]
          /\ everApproved \in [Proposals -> BOOLEAN]

Init == /\ state = [p \in Proposals |-> "none"]
        /\ everApproved = [p \in Proposals |-> FALSE]

Create(p)     == /\ state[p] = "none"
                 /\ state' = [state EXCEPT ![p] = "proposed"]
                 /\ UNCHANGED everApproved
Gate(p)       == /\ state[p] = "proposed"
                 /\ state' = [state EXCEPT ![p] = "gated"]
                 /\ UNCHANGED everApproved
Approve(p)    == /\ state[p] = "gated"
                 /\ state' = [state EXCEPT ![p] = "approved"]
                 /\ everApproved' = [everApproved EXCEPT ![p] = TRUE]
Reject(p)     == /\ state[p] = "gated"
                 /\ state' = [state EXCEPT ![p] = "rejected"]
                 /\ UNCHANGED everApproved
Apply(p)      == /\ state[p] = "approved"
                 /\ state' = [state EXCEPT ![p] = "applied"]
                 /\ UNCHANGED everApproved
Monitor(p)    == /\ state[p] = "applied"
                 /\ Cardinality({q \in Proposals : state[q] = "monitoring"}) < K
                 /\ state' = [state EXCEPT ![p] = "monitoring"]
                 /\ UNCHANGED everApproved
Stabilize(p)  == /\ state[p] = "monitoring"
                 /\ state' = [state EXCEPT ![p] = "stable"]
                 /\ UNCHANGED everApproved
Revert(p)     == /\ state[p] = "monitoring"
                 /\ state' = [state EXCEPT ![p] = "reverted"]
                 /\ UNCHANGED everApproved
Quarantine(p) == /\ state[p] = "reverted"
                 /\ state' = [state EXCEPT ![p] = "quarantined"]
                 /\ UNCHANGED everApproved
Release(p)    == /\ state[p] = "quarantined"
                 /\ state' = [state EXCEPT ![p] = "proposed"]
                 /\ UNCHANGED everApproved

Next == \E p \in Proposals :
          \/ Create(p) \/ Gate(p) \/ Approve(p) \/ Reject(p)
          \/ Apply(p) \/ Monitor(p) \/ Stabilize(p) \/ Revert(p)
          \/ Quarantine(p) \/ Release(p)

Spec == Init /\ [][Next]_vars

(* I1: nothing is ever applied without having passed through approved.      *)
I1_GateSoundness == \A p \in Proposals :
  state[p] \in {"applied", "monitoring", "stable", "reverted", "quarantined"}
    => everApproved[p]

(* I2: bounded monitoring concurrency.                                      *)
I2_BoundedMonitoring ==
  Cardinality({p \in Proposals : state[p] = "monitoring"}) <= K

(* I3: from monitoring, reverted is reachable without human action — the    *)
(* Revert action exists and is enabled in every monitoring state.           *)
I3_RevertEnabled == \A p \in Proposals :
  state[p] = "monitoring" => ENABLED Revert(p)

=============================================================================

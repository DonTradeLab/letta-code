// src/cli/app/useQueuedApprovalSubmit.ts

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { type Dispatch, type MutableRefObject, useCallback } from "react";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  buildFreshDenialApprovals,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";

import { createClientOtid } from "./ids";
import type {
  ProcessConversation,
  QueueApprovalResults,
  QueuedApprovalMetadata,
  TuiTurnAdmission,
} from "./types";

type QueuedApprovalSubmitContext = {
  agentId: string;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  interruptQueuedRef: MutableRefObject<boolean>;
  needsEagerApprovalCheck: boolean;
  processConversation: ProcessConversation;
  queueApprovalResults: QueueApprovalResults;
  queuedApprovalMetadataRef: MutableRefObject<QueuedApprovalMetadata | null>;
  queuedApprovalResultsRef: MutableRefObject<ApprovalResult[] | null>;
  setNeedsEagerApprovalCheck: Dispatch<boolean>;
};

export function useQueuedApprovalSubmit(ctx: QueuedApprovalSubmitContext) {
  const {
    agentId,
    conversationGenerationRef,
    conversationIdRef,
    interruptQueuedRef,
    needsEagerApprovalCheck,
    processConversation,
    queueApprovalResults,
    queuedApprovalMetadataRef,
    queuedApprovalResultsRef,
    setNeedsEagerApprovalCheck,
  } = ctx;

  /**
   * Check and handle any pending approvals before sending a slash command.
   * Returns true if approvals need user input (caller should return { submitted: false }).
   * Returns false if no approvals or all auto-handled (caller can proceed).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: queued approval refs are stable objects; .current is read dynamically during the check.
  const checkPendingApprovalsForSlashCommand = useCallback(async (): Promise<
    { blocked: true } | { blocked: false }
  > => {
    // Only check eagerly when resuming a session (LET-7101)
    if (!needsEagerApprovalCheck) {
      return { blocked: false };
    }

    const queuedMetadata = queuedApprovalMetadataRef.current;
    const hasQueuedRealResults =
      queuedApprovalResultsRef.current !== null &&
      queuedApprovalResultsRef.current.length > 0 &&
      queuedMetadata?.conversationId === conversationIdRef.current &&
      queuedMetadata.generation === conversationGenerationRef.current;
    if (hasQueuedRealResults) {
      setNeedsEagerApprovalCheck(false);
      return { blocked: false };
    }

    try {
      const agent = await getBackend().retrieveAgent(agentId);
      const { pendingApprovals: existingApprovals } =
        await getResumeDataFromBackend(agent, conversationIdRef.current);

      if (!existingApprovals || existingApprovals.length === 0) {
        setNeedsEagerApprovalCheck(false);
        return { blocked: false };
      }

      const staleDenials = buildFreshDenialApprovals(
        existingApprovals,
        STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      ) as ApprovalResult[];
      if (staleDenials.length > 0) {
        queueApprovalResults(staleDenials, {
          conversationId: conversationIdRef.current,
          generation: conversationGenerationRef.current,
        });
        setNeedsEagerApprovalCheck(false);
      }

      return { blocked: false };
    } catch {
      // If check fails, proceed anyway (don't block user)
      return { blocked: false };
    }
  }, [
    agentId,
    needsEagerApprovalCheck,
    queueApprovalResults,
    setNeedsEagerApprovalCheck,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: queued approval refs are stable objects; .current is revalidated synchronously at admission.
  const peekQueuedApprovalInputForCurrentConversation = useCallback(
    (otid: string = createClientOtid()) => {
      const queuedResults = queuedApprovalResultsRef.current;
      if (!queuedResults || queuedResults.length === 0) {
        return null;
      }

      const queuedMetadata = queuedApprovalMetadataRef.current;
      const isQueuedValid =
        queuedMetadata &&
        queuedMetadata.conversationId === conversationIdRef.current &&
        queuedMetadata.generation === conversationGenerationRef.current;

      if (!isQueuedValid) {
        debugWarn(
          "queue",
          "Retaining stale queued approval results; they will not cross conversation/generation scope",
        );
        return null;
      }

      const input: ApprovalCreate = {
        type: "approval",
        approvals: queuedResults,
        otid,
      };
      return {
        input,
        isCurrent: () =>
          queuedApprovalResultsRef.current === queuedResults &&
          queuedApprovalMetadataRef.current === queuedMetadata &&
          conversationIdRef.current === queuedMetadata.conversationId &&
          conversationGenerationRef.current === queuedMetadata.generation,
        commit: () => {
          queueApprovalResults(null);
          interruptQueuedRef.current = false;
        },
      };
    },
    [queueApprovalResults, interruptQueuedRef],
  );

  const processConversationWithQueuedApprovals = useCallback(
    async (
      input: Array<MessageCreate | ApprovalCreate>,
      options?: Parameters<typeof processConversation>[1],
    ): Promise<TuiTurnAdmission> => {
      const queuedApprovalPlan =
        peekQueuedApprovalInputForCurrentConversation();
      const nextInput = queuedApprovalPlan
        ? [queuedApprovalPlan.input, ...input]
        : input;
      const outerCommit = options?.admissionCommit;
      return processConversation(nextInput, {
        ...options,
        admissionCommit:
          queuedApprovalPlan || outerCommit
            ? () => {
                if (queuedApprovalPlan && !queuedApprovalPlan.isCurrent()) {
                  return false;
                }
                if (outerCommit && !outerCommit()) {
                  return false;
                }
                queuedApprovalPlan?.commit();
                return true;
              }
            : undefined,
      });
    },
    [peekQueuedApprovalInputForCurrentConversation, processConversation],
  );

  return {
    checkPendingApprovalsForSlashCommand,
    peekQueuedApprovalInputForCurrentConversation,
    processConversationWithQueuedApprovals,
  };
}

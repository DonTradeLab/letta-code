export type TuiAdmissionTestPhase = "submit_prepare";

type TuiAdmissionTestHook = (
  phase: TuiAdmissionTestPhase,
) => void | Promise<void>;

let testHook: TuiAdmissionTestHook | null = null;

/** Test-only deterministic wait/failure injection for real Ink/App coverage. */
export function setTuiAdmissionTestHook(
  hook: TuiAdmissionTestHook | null,
): void {
  testHook = hook;
}

export async function runTuiAdmissionTestHook(
  phase: TuiAdmissionTestPhase,
): Promise<void> {
  await testHook?.(phase);
}

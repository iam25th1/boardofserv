// The step ids of the approvals about a run's held messages
// (runtime/held.ts): one about them all, and one for each message after
// Pick one by one. No step of an agent's has an id that starts with "_".
export const HELD_ALL = "_messages";
export const HELD_ONE = "_message:";
export const isHeldStep = (stepId: string) => stepId === HELD_ALL || stepId.startsWith(HELD_ONE);

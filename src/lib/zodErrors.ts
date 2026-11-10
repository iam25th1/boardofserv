import type { z } from "zod";

// Zod 4 words a missing field as "Invalid input: expected string, received
// undefined". Where its messages go back to the model that wrote the input
// (an agent's definition, a tool's arguments), a missing field keeps zod
// 3's plain "Required".
export const keepRequired: z.core.$ZodErrorMap = (iss) => (iss.code === "invalid_type" && iss.input === undefined ? "Required" : undefined);

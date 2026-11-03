import { z } from "zod";
import { adminDTO } from "@/lib/payments/admin";
import { chainClient, chainError } from "@/lib/payments/chain";
import { approveWithdrawal, failStuckWithdrawal, rejectWithdrawal } from "@/lib/payments/withdrawals";
import { requireAdmin } from "../../guard";

export const runtime = "nodejs";

const Body = z.object({ action: z.enum(["approve", "reject", "fail"]) });

// An admin decides a withdrawal: approve or reject one waiting for approval,
// cancel ("reject") one queued but not yet sent (both give the amount back),
// or mark a stuck payout failed (only when its nonce went to another
// transaction, which also gives it back).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const who = await requireAdmin(req);
  if ("refused" in who) return who.refused;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !z.string().uuid().safeParse(params.id).success) return Response.json({ error: "Approve, reject or fail a withdrawal." }, { status: 400 });
  const { action } = parsed.data;
  let done: boolean;
  try {
    done =
      action === "approve"
        ? await approveWithdrawal(params.id, who.admin.id)
        : action === "reject"
          ? await rejectWithdrawal(params.id, who.admin.id)
          : await failStuckWithdrawal(params.id, who.admin.id, chainClient());
  } catch (err) {
    // A chain error never reaches the log whole: it can carry the RPC address.
    console.error(`payments: an admin ${action} failed: ${chainError(err)}`);
    return Response.json({ error: "The chain could not be read just now. Try again." }, { status: 502 });
  }
  if (!done) return Response.json({ error: "That withdrawal can't be changed that way now." }, { status: 409 });
  console.info(`payments: an admin chose ${action} for a withdrawal.`);
  return Response.json({ admin: await adminDTO(chainClient()) });
}

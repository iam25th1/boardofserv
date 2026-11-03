import { paymentsDTO } from "@/lib/payments/dto";
import { qrPath } from "@/lib/qr";
import { WalletView } from "./WalletView";

// Read at request time: the payments config comes from the server's env.
export const dynamic = "force-dynamic";

export default function WalletPage() {
  const payments = paymentsDTO();
  return <WalletView payments={payments} qr={payments.treasury ? qrPath(payments.treasury) : null} />;
}

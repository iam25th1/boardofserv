import { AppShell } from "@/components/shell/AppShell";

// A published helper's page sits in the app's shell too.
export default function HelperLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

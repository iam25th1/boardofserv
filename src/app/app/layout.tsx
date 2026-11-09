import { AppShell } from "@/components/shell/AppShell";

// Every page of the app sits in the one shell.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

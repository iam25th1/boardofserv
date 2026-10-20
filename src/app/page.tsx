import { redirect } from "next/navigation";

// The app lives at /chat. The query string is kept, so development links like
// /?sketch=demo still reach the chat with their flag.
export default function Home({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const qs = query.toString();
  redirect(qs ? `/chat?${qs}` : "/chat");
}

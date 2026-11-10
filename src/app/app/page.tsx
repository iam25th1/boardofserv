import { redirect } from "next/navigation";

// The app's front door is the chat. The query string is kept, so
// development links like /app?sketch=demo still reach the chat with their
// flag.
export default async function AppHome(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await props.searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const qs = query.toString();
  redirect(qs ? `/app/chat?${qs}` : "/app/chat");
}

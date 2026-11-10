import { redirect } from "next/navigation";
import { Landing } from "@/components/landing/Landing";

// The public front page. (Development links like /?sketch=demo still reach
// the chat with their flag.)
export default async function Home(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const searchParams = await props.searchParams;
  if (typeof searchParams.sketch === "string") redirect(`/app/chat?sketch=${encodeURIComponent(searchParams.sketch)}`);
  return <Landing />;
}

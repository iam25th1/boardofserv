import { NextResponse } from "next/server";

// boardofserv uses no next/image, so the image optimizer endpoint is
// closed: next 14's optimizer has advisories only a major upgrade fixes,
// and nothing here needs it.
export function middleware() {
  return new NextResponse(null, { status: 404 });
}

export const config = { matcher: ["/_next/image"] };

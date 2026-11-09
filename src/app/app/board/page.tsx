"use client";
import { BoardView } from "@/components/market/BoardView";
import { fetchBoard } from "@/lib/publicApi";

// The board, for anyone (components/market/BoardView.tsx).
export default function BoardPage() {
  return <BoardView load={fetchBoard} />;
}

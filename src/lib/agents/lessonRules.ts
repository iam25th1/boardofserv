// The rules learned from earlier builds (lessons.ts), as a prompt's last
// lines, or nothing when there are none. No dependencies: the planner and
// code writing take it.
export function rulesText(rules: string[] | undefined): string {
  return rules?.length ? `\nRules learned from earlier builds, keep to them:\n${rules.map((r) => `- ${r}`).join("\n")}` : "";
}

export type PromptOverrides = {
  promptOverride?: string | null;
  requiredInstructions?: string[] | null;
  lengthInstruction?: string | null;
  languageInstruction?: string | null;
};

export function buildInstructions({
  base,
  overrides,
}: {
  base: string;
  overrides?: PromptOverrides | null;
}): string {
  const lines: string[] = [];
  const override = overrides?.promptOverride?.trim();
  if (override) {
    lines.push(override);
  } else {
    const trimmedBase = base.trim();
    if (trimmedBase) lines.push(trimmedBase);
  }

  const requiredInstructions = overrides?.requiredInstructions ?? [];
  for (const instruction of requiredInstructions) {
    const trimmed = instruction.trim();
    if (trimmed) lines.push(trimmed);
  }

  const lengthInstruction = overrides?.lengthInstruction?.trim();
  if (lengthInstruction) lines.push(lengthInstruction);

  const languageInstruction = overrides?.languageInstruction?.trim();
  if (languageInstruction) lines.push(languageInstruction);

  return lines.join("\n");
}

export function buildTaggedPrompt({
  instructions,
  context,
  content,
}: {
  instructions: string;
  context: string;
  content: string;
}): string {
  const escapeTaggedValue = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeInstructions = instructions.trim();
  const safeContext = escapeTaggedValue(context.trim());
  const safeContent = escapeTaggedValue(typeof content === "string" ? content : "");
  return `<instructions>\n${safeInstructions}\n</instructions>\n\n<context>\n${safeContext}\n</context>\n\n<content>\n${safeContent}\n</content>\n`;
}

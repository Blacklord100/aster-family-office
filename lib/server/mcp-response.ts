/** MCP serializes both text and structured output. Keep the combined payload bounded. */
export function mcpResult(data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    return {
      content: [
        {
          type: 'text' as const,
          text: 'This result is too large. Reduce limit or narrow the requested records, then continue with nextOffset. Full records remain available in Aster.',
        },
      ],
      isError: true,
    };
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: data,
  };
}

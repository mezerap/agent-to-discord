export async function say(channel, text, extra = {}) {
  const content = String(text || '(Prázdná odpověď)');
  let result;
  for (let i = 0; i < content.length; i += 1900) {
    result = await channel.send({ content: content.slice(i, i + 1900), allowedMentions: { parse: [] },
      ...(i + 1900 >= content.length ? extra : {}) });
  }
  return result;
}

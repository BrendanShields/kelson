// UX-15/UX-9: the streaming-delta write site — model output streams
// token-by-token, which a line-oriented sink cannot carry. Allowlisted in
// the UX-9 obligation test alongside sink.ts and json.ts.

export const streamOut = (text: string): void => {
  process.stdout.write(text);
};

// What every agent here prints: its answer to PROMPT as one line of JSON, or the error it got, and
// exit 1 then. The tests read the line from Node and Python agents alike.
export async function answer(ask) {
  try {
    console.log(JSON.stringify({ answer: await ask(process.env.PROMPT ?? 'hello') }));
  } catch (err) {
    console.log(JSON.stringify({ error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err) }));
    process.exitCode = 1;
  }
}

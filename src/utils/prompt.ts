import { createInterface } from "node:readline";

/** Résout quand l'utilisateur appuie sur Entrée dans le terminal. */
export function waitForEnter(message: string): { promise: Promise<void>; cancel: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let done = false;
  const promise = new Promise<void>((resolve) => {
    rl.question(`${message}\n> `, () => {
      done = true;
      rl.close();
      resolve();
    });
  });
  return {
    promise,
    cancel: () => {
      if (!done) rl.close();
    },
  };
}

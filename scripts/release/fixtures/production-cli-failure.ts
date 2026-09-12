import { exitAfterProductionCliFailure } from "../production-cli.ts";

setInterval(() => {}, 60_000);
exitAfterProductionCliFailure(`${JSON.stringify({ outcome: "failed" })}\n`, process.stdout);

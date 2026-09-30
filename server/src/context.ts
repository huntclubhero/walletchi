import type { Store } from "./store/types.js";
import type { Relayer } from "./chain/relayer.js";

// The wiring passed to routes + services. Production wires PrismaStore + live
// Relayer; the smoke test wires InMemoryStore + MockChain. Same code paths.
export interface AppContext {
  store: Store;
  relayer: Relayer;
}

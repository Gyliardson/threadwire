import { assertApiConfigCompatible, loadApiConfig } from "./api/ApiConfig.js";
import { createThreadwireHttpServer } from "./api/ThreadwireHttpServer.js";
import { loadConfig } from "./config/ControllerConfig.js";
import { createThreadwireController } from "./controller/ThreadwireController.js";
import { loadThreadRegistryPersistenceConfig } from "./persistence/ThreadRegistryPersistenceConfig.js";
import { JsonFileThreadRegistryStore } from "./persistence/ThreadRegistryStore.js";

const controllerConfig = loadConfig();
const apiConfig = loadApiConfig();
const persistenceConfig = loadThreadRegistryPersistenceConfig();
assertApiConfigCompatible(apiConfig, controllerConfig);

const threadRegistryStore = new JsonFileThreadRegistryStore(persistenceConfig.stateFile);
const controller = createThreadwireController(controllerConfig, { threadRegistryStore });
const server = createThreadwireHttpServer(apiConfig, controller);
await server.start();

console.log(`Threadwire API listening on http://${apiConfig.apiHost}:${apiConfig.apiPort}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await server.close();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

import { AgentRunner } from "./agent/loop";
import { getConfig } from "./config";
import { logger } from "./logger";
import { MetaModelClient } from "./meta/client";
import { getStore } from "./storage";

let runner: AgentRunner | undefined;

/** Process-wide AgentRunner built from environment configuration. */
export function getRunner(): AgentRunner {
  if (runner) return runner;
  const config = getConfig();
  runner = new AgentRunner({
    config,
    store: getStore(config.storage),
    model: new MetaModelClient({ config: config.meta, logger }),
    logger,
  });
  return runner;
}

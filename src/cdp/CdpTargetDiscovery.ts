import http from "http";
import { ControllerConfig } from "../config/ControllerConfig.js";
import { CdpTargetList, CdpTargetInfo } from "./types.js";
import { CdpTargetNotFoundError, CdpEndpointTimeoutError } from "../domain/errors.js";

const ENDPOINT_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 250;

export class CdpTargetDiscovery {
  private config: ControllerConfig;

  constructor(config: ControllerConfig) {
    this.config = config;
  }

  public async getTargets(): Promise<CdpTargetList> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${this.config.cdpHost}:${this.config.cdpPort}/json/list`,
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                const targets = JSON.parse(data) as CdpTargetList;
                resolve(targets);
              } catch (e) {
                reject(new Error("Failed to parse CDP target list"));
              }
            } else {
              reject(new Error(`CDP endpoint returned status: ${res.statusCode}`));
            }
          });
        }
      );

      req.on("error", (err) => {
        reject(err);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error("Request timeout to CDP endpoint"));
      });
    });
  }

  public async findPrimaryTarget(): Promise<CdpTargetInfo> {
    const startWait = Date.now();

    while (Date.now() - startWait < ENDPOINT_TIMEOUT_MS) {
      try {
        const targets = await this.getTargets();
        
        // Target classification:
        // 1. type must be 'page'
        // 2. url must be 'chatgpt.com'
        const candidate = targets.find(
          (t) => t.type === "page" && t.url.includes("chatgpt.com")
        );

        if (candidate) {
          return candidate;
        }
      } catch (err) {
        // Ignored, maybe the endpoint is not up yet
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new CdpEndpointTimeoutError();
  }
}

import {
  ResponseStreamConsumer,
  ResponseStreamConsumerError,
  ResponseStreamConsumerOptions,
} from "../response/ResponseStreamConsumer.js";
import { ResponseStreamEvent } from "../response/types.js";
import {
  CdpResponseStreamFailureKind,
  CdpTurnResponseObservation,
} from "./CdpTransport.js";
import {
  ExperimentalDataReceivedEvent,
  ExperimentalNetworkDomain,
} from "./ChromeRemoteInterfaceHelpers.js";

const MAX_PENDING_LIVE_BASE64_CHARS = 2_796_204;
const MAX_PENDING_LIVE_CHUNKS = 1024;

export class CdpResponseStreamTracker {
  private selectedRequestId: string | null = null;
  private lifecycle: "PENDING" | "STREAMING" | "COMPLETED" | "FAILED" = "PENDING";
  private failure: CdpResponseStreamFailureKind | null = null;
  private consumer: ResponseStreamConsumer | null;
  private activationPending = false;
  private activated = false;
  private transportSettledWhileActivationPending = false;
  private pendingLiveData: string[] = [];
  private pendingLiveBase64Chars = 0;
  private disposed = false;

  public constructor(
    private readonly network: ExperimentalNetworkDomain,
    private readonly dataObservationAvailable: boolean,
    consumerOptions: ResponseStreamConsumerOptions = {},
  ) {
    this.consumer = new ResponseStreamConsumer(consumerOptions);
  }

  public snapshot(): CdpTurnResponseObservation {
    return Object.freeze({ lifecycle: this.lifecycle, failure: this.failure });
  }

  public select(requestId: string): void {
    if (!this.disposed && this.selectedRequestId === null) {
      this.selectedRequestId = requestId;
    }
  }

  public begin(requestId: string): void {
    if (
      !this.isCurrent(requestId) ||
      this.lifecycle !== "PENDING" ||
      this.activationPending ||
      this.activated
    ) {
      return;
    }

    const streamResourceContent = this.network.streamResourceContent;
    if (!this.dataObservationAvailable || typeof streamResourceContent !== "function") {
      this.fail("UNAVAILABLE");
      return;
    }

    this.activationPending = true;
    let activation: Promise<{ readonly bufferedData?: string }>;
    try {
      activation = streamResourceContent.call(this.network, { requestId });
    } catch {
      this.fail("ACTIVATION_FAILED");
      return;
    }

    void activation.then(
      (result) => this.completeActivation(requestId, result.bufferedData),
      () => {
        if (this.isCurrent(requestId)) {
          this.fail("ACTIVATION_FAILED");
        }
      },
    );
  }

  public onData(event: ExperimentalDataReceivedEvent): void {
    const data = event.data;
    if (
      typeof data !== "string" ||
      !this.isCurrent(event.requestId) ||
      this.lifecycle === "FAILED" ||
      this.lifecycle === "COMPLETED"
    ) {
      return;
    }

    if (this.activationPending && !this.activated) {
      if (this.pendingLiveData.length >= MAX_PENDING_LIVE_CHUNKS) {
        this.fail("BUFFER_OVERFLOW");
        return;
      }
      this.pendingLiveBase64Chars += data.length;
      if (this.pendingLiveBase64Chars > MAX_PENDING_LIVE_BASE64_CHARS) {
        this.fail("BUFFER_OVERFLOW");
        return;
      }
      this.pendingLiveData.push(data);
      return;
    }

    if (this.activated) {
      this.consumeBase64(data);
    }
  }

  public onTransportSettled(requestId: string, failed: boolean): void {
    if (!this.isCurrent(requestId) || this.lifecycle === "COMPLETED") {
      return;
    }
    if (failed) {
      this.fail("INCOMPLETE");
      return;
    }
    if (this.activationPending) {
      this.transportSettledWhileActivationPending = true;
      return;
    }
    if (this.lifecycle === "STREAMING") {
      this.finishConsumer();
      return;
    }
    if (this.lifecycle === "PENDING") {
      this.fail("INCOMPLETE");
    }
  }

  public drain(): readonly ResponseStreamEvent[] {
    return this.consumer?.drain() ?? Object.freeze([]);
  }

  public fail(failure: CdpResponseStreamFailureKind): void {
    if (this.disposed || this.lifecycle === "COMPLETED") {
      return;
    }
    this.lifecycle = "FAILED";
    this.failure = failure;
    this.consumer?.stop();
    this.activationPending = false;
    this.activated = false;
    this.pendingLiveData = [];
    this.pendingLiveBase64Chars = 0;
  }

  public discard(): void {
    if (this.disposed) {
      return;
    }
    this.consumer?.dispose();
    this.consumer = null;
    this.activationPending = false;
    this.activated = false;
    this.pendingLiveData = [];
    this.pendingLiveBase64Chars = 0;
    if (this.lifecycle !== "COMPLETED") {
      this.lifecycle = "FAILED";
      this.failure = "CONSUMER_STOPPED";
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.selectedRequestId = null;
    this.consumer?.dispose();
    this.consumer = null;
    this.activationPending = false;
    this.activated = false;
    this.pendingLiveData = [];
    this.pendingLiveBase64Chars = 0;
  }

  private completeActivation(requestId: string, bufferedData: string | undefined): void {
    if (!this.isCurrent(requestId)) {
      return;
    }
    this.activationPending = false;
    if (this.lifecycle === "FAILED") {
      return;
    }
    this.activated = true;
    this.lifecycle = "STREAMING";

    if (typeof bufferedData === "string" && bufferedData.length > 0) {
      this.consumeBase64(bufferedData);
    }
    if (this.isTerminal()) {
      this.pendingLiveData = [];
      this.pendingLiveBase64Chars = 0;
      return;
    }

    const pending = this.pendingLiveData;
    this.pendingLiveData = [];
    this.pendingLiveBase64Chars = 0;
    for (const data of pending) {
      this.consumeBase64(data);
      if (this.isTerminal()) {
        break;
      }
    }

    if (this.transportSettledWhileActivationPending && this.lifecycle === "STREAMING") {
      this.finishConsumer();
    }
  }

  private consumeBase64(data: string): void {
    const consumer = this.consumer;
    if (consumer === null) {
      return;
    }
    try {
      consumer.pushBase64(data);
      if (consumer.completed) {
        this.lifecycle = "COMPLETED";
        this.failure = null;
        this.pendingLiveData = [];
        this.pendingLiveBase64Chars = 0;
      }
    } catch (error) {
      if (error instanceof ResponseStreamConsumerError && error.kind === "BUFFER_OVERFLOW") {
        this.fail("BUFFER_OVERFLOW");
        return;
      }
      this.fail("PARSE_FAILED");
    }
  }

  private finishConsumer(): void {
    const consumer = this.consumer;
    if (consumer === null) {
      this.fail("INCOMPLETE");
      return;
    }
    try {
      consumer.finish();
    } catch (error) {
      if (error instanceof ResponseStreamConsumerError && error.kind === "BUFFER_OVERFLOW") {
        this.fail("BUFFER_OVERFLOW");
        return;
      }
      this.fail("PARSE_FAILED");
      return;
    }
    if (consumer.completed) {
      this.lifecycle = "COMPLETED";
      this.failure = null;
      return;
    }
    this.fail("INCOMPLETE");
  }

  private isCurrent(requestId: string): boolean {
    return !this.disposed && this.selectedRequestId === requestId;
  }

  private isTerminal(): boolean {
    return this.lifecycle === "FAILED" || this.lifecycle === "COMPLETED";
  }
}

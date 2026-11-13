import {
	AbstractChat,
	type ChatInit,
	type ChatRequestOptions,
	type ChatState,
	type ChatStatus,
	type ChatTransport,
	type UIMessage,
} from "ai";

export type ThreadRunSpec = {
	id: string;
	initialPathMessageId: string | null;
	messageId?: string;
	parentMessageId: string | null;
	siblingOrder: number;
};

export interface ThreadRunHost<TMessage extends UIMessage> {
	readonly dataPartSchemas: ChatInit<TMessage>["dataPartSchemas"];
	readonly id: string;
	readonly messageMetadataSchema: ChatInit<TMessage>["messageMetadataSchema"];
	onData: ChatInit<TMessage>["onData"];
	onError: ChatInit<TMessage>["onError"];
	onFinish: ChatInit<TMessage>["onFinish"];
	onToolCall: ChatInit<TMessage>["onToolCall"];
	sendAutomaticallyWhen: ChatInit<TMessage>["sendAutomaticallyWhen"];
	transport: ChatTransport<TMessage>;
	generateMessageId: () => string;
	getMessagePath: (messageId: string | null) => TMessage[];
	updateRunPath: (messages: TMessage[]) => void;
	registerToolCall: (runId: string, toolCallId: string) => void;
	removeMessage: (messageId: string) => void;
	setRunError: (runId: string, error: Error | undefined) => void;
	setRunStatus: (runId: string, status: ChatStatus) => void;
	writeRunMessage: (runId: string, message: TMessage) => void;
}

class ThreadRunState<TMessage extends UIMessage>
	implements ChatState<TMessage>
{
	#error: Error | undefined;
	readonly #host: ThreadRunHost<TMessage>;
	#messages: TMessage[];
	readonly #spec: ThreadRunSpec;
	#status: ChatStatus = "ready";

	constructor(host: ThreadRunHost<TMessage>, spec: ThreadRunSpec) {
		this.#host = host;
		this.#messages = host.getMessagePath(spec.initialPathMessageId);
		this.#spec = spec;
	}

	get error() {
		return this.#error;
	}

	set error(error: Error | undefined) {
		this.#error = error;
		this.#host.setRunError(this.#spec.id, error);
	}

	get messages() {
		return this.#messages;
	}

	set messages(messages: TMessage[]) {
		this.#messages = messages;
		this.#host.updateRunPath(messages);
	}

	get status() {
		return this.#status;
	}

	set status(status: ChatStatus) {
		this.#status = status;
		this.#host.setRunStatus(this.#spec.id, status);
	}

	refreshPath() {
		this.#messages = this.#host.getMessagePath(
			this.#spec.messageId ?? this.#spec.initialPathMessageId,
		);
	}

	popMessage = () => {
		const lastMessage = this.#messages.pop();
		if (lastMessage) this.#host.removeMessage(lastMessage.id);
	};

	pushMessage = (message: TMessage) => {
		this.#messages.push(message);
		this.writeMessage(message);
	};

	replaceMessage = (index: number, message: TMessage) => {
		if (index !== this.#messages.length - 1) {
			throw new Error("A thread run can only replace its current response");
		}
		this.#messages[index] = message;
		this.writeMessage(message);
	};

	snapshot = <T>(thing: T): T => structuredClone(thing);

	private writeMessage(message: TMessage) {
		this.#host.writeRunMessage(this.#spec.id, message);
	}
}

/** One `resume()` call; it looks for a stream until the transport hands one over. */
type ResumeAttempt = { lookingForStream: boolean };

export class ThreadRunChat<
	TMessage extends UIMessage,
> extends AbstractChat<TMessage> {
	readonly #resumes: { current: ResumeAttempt | undefined };
	readonly #state: ThreadRunState<TMessage>;

	constructor(host: ThreadRunHost<TMessage>, spec: ThreadRunSpec) {
		const responseMessageId = host.generateMessageId();
		const state = new ThreadRunState(host, spec);
		const resumes: { current: ResumeAttempt | undefined } = {
			current: undefined,
		};
		const transport: ChatTransport<TMessage> = {
			// `ai` calls this synchronously from `resumeStream`, so `resumes.current` is
			// the attempt that asked.
			//
			// `ai` 6.0.323 builds a resumed response from empty state: it seeds it from
			// the stored message only for a tool call still streaming its input, or
			// from state it kept itself after a network disconnect of the same chat
			// instance (never after a reload). A stream that merely continues the
			// stored response would therefore replace it with the continuation, and a
			// continuation chunk for a part opened before the disconnect would find no
			// part. Only a replay, which rebuilds the whole response, is correct, so
			// anything else that carries a stream is refused instead of attempted.
			reconnectToStream: async (options) => {
				const attempt = resumes.current;
				const stream = await host.transport.reconnectToStream(options);
				if (!stream) {
					return stream;
				}
				if (attempt) {
					attempt.lookingForStream = false;
				}
				if (
					host.transport.resumeStreamIsReplay !== true &&
					!options.abortSignal?.aborted
				) {
					await stream.cancel().catch(() => undefined);
					throw new Error(
						"A run can only be resumed over a transport whose reconnectToStream replays the whole response (resumeStreamIsReplay: true): the AI SDK rebuilds a resumed response from empty state, so a stream that only continues the stored response would replace it.",
					);
				}
				return stream;
			},
			// Read per resume, so a transport replaced on the thread applies to it.
			get resumeStreamIsReplay() {
				return host.transport.resumeStreamIsReplay;
			},
			sendMessages: (options) => {
				return host.transport.sendMessages({
					...options,
					messageId:
						spec.messageId === undefined && options.trigger === "submit-message"
							? undefined
							: options.messageId,
				});
			},
		};
		super({
			dataPartSchemas: host.dataPartSchemas,
			// `ai` builds a resumed response from empty state under this id, so a run
			// rebuilt around an existing assistant must reuse that assistant's id: a
			// replay whose `start` chunk carries no id would otherwise bind the run to
			// a second message.
			generateId: () => spec.messageId ?? responseMessageId,
			id: host.id,
			messageMetadataSchema: host.messageMetadataSchema,
			onData: (event) => host.onData?.(event),
			onError: (error) => {
				host.onError?.(error);
			},
			onFinish: (event) => {
				host.onFinish?.({
					...event,
					messages: host.getMessagePath(spec.messageId ?? spec.parentMessageId),
				});
			},
			onToolCall: async (event) => {
				host.registerToolCall(spec.id, event.toolCall.toolCallId);
				await host.onToolCall?.(event);
			},
			sendAutomaticallyWhen: (event) =>
				host.sendAutomaticallyWhen?.(event) ?? false,
			state,
			transport,
		});
		this.#resumes = resumes;
		this.#state = state;
	}

	refreshPath() {
		this.#state.refreshPath();
	}

	/**
	 * `resumeStream`, which on `ai` 6.0.323 reports a resume that finds no stream
	 * as status "ready" and so drops the run's error. A failed run keeps its error
	 * until the caller clears it: `setStatus` ignores that report while this
	 * attempt is still looking for a stream, so the host never sees the error
	 * leave. The attempt is per call: a newer `resume` replaces it, and a
	 * superseded one neither decides nor clears anything.
	 */
	async resume(options?: ChatRequestOptions) {
		const attempt: ResumeAttempt = { lookingForStream: true };
		this.#resumes.current = attempt;
		try {
			await this.resumeStream(options);
		} finally {
			if (this.#resumes.current === attempt) {
				this.#resumes.current = undefined;
			}
		}
	}

	protected override setStatus(update: { error?: Error; status: ChatStatus }) {
		if (
			update.status === "ready" &&
			this.status === "error" &&
			this.error !== undefined &&
			this.#resumes.current?.lookingForStream
		) {
			return;
		}
		super.setStatus(update);
	}

	start(options?: ChatRequestOptions) {
		return this.sendMessage(undefined, options);
	}

	startWithMessage(
		message: NonNullable<Parameters<AbstractChat<TMessage>["sendMessage"]>[0]>,
		options?: ChatRequestOptions,
	) {
		return this.sendMessage(message, options);
	}

	regenerateMessage(messageId: string, options?: ChatRequestOptions) {
		return this.regenerate({ ...options, messageId });
	}
}

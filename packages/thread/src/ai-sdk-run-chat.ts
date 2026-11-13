import {
	AbstractChat,
	type ChatInit,
	type ChatRequestOptions,
	type ChatState,
	type ChatStatus,
	type ChatTransport,
	type UIMessage,
	type UIMessageChunk,
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

type MessagePart = UIMessage["parts"][number];

/** Whether `resumed` is `stored` carried on: the same tool call, or the same text grown. */
function continuesPart(stored: MessagePart, resumed: MessagePart) {
	if (stored.type !== resumed.type) return false;
	if ("toolCallId" in stored && "toolCallId" in resumed) {
		return stored.toolCallId === resumed.toolCallId;
	}
	if (
		(stored.type === "text" || stored.type === "reasoning") &&
		(resumed.type === "text" || resumed.type === "reasoning")
	) {
		return resumed.text.startsWith(stored.text);
	}
	return JSON.stringify(stored) === JSON.stringify(resumed);
}

function includesParts(resumed: MessagePart[], stored: MessagePart[]) {
	return (
		resumed.length >= stored.length &&
		stored.every((part, index) => {
			const carried = resumed[index];
			return carried !== undefined && continuesPart(part, carried);
		})
	);
}

class ThreadRunState<TMessage extends UIMessage>
	implements ChatState<TMessage>
{
	#error: Error | undefined;
	/** The stored response a resume must extend, and whether `ai` already seeded it. */
	#extension: { base: TMessage; seeded: boolean | undefined } | undefined;
	/** What the host was last told, kept while `ai`'s own writes are not passed on. */
	#held: { error: Error | undefined; status: ChatStatus } | undefined;
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
		if (!this.#held) this.#host.setRunError(this.#spec.id, error);
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
		if (!this.#held) this.#host.setRunStatus(this.#spec.id, status);
	}

	/** Stop passing status and error to the host; it keeps what it was told last. */
	hold() {
		this.#held ??= { error: this.#error, status: this.#status };
	}

	/** Tell the host what the held run ended up with. */
	release() {
		if (!this.#held) return;
		this.#held = undefined;
		this.#host.setRunStatus(this.#spec.id, this.#status);
		this.#host.setRunError(this.#spec.id, this.#error);
	}

	/** Forget what `ai` did while held: the host never saw it. */
	restore() {
		if (!this.#held) return;
		({ error: this.#error, status: this.#status } = this.#held);
		this.#held = undefined;
	}

	/** Extend `base` with what a resumed stream adds, or stop doing so for `undefined`. */
	extendResponse(base: TMessage | undefined) {
		this.#extension = base ? { base, seeded: undefined } : undefined;
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
		const written = this.withExtension(message);
		this.#messages.push(written);
		this.writeMessage(written);
	};

	replaceMessage = (index: number, message: TMessage) => {
		if (index !== this.#messages.length - 1) {
			throw new Error("A thread run can only replace its current response");
		}
		const written = this.withExtension(message);
		this.#messages[index] = written;
		this.writeMessage(written);
	};

	snapshot = <T>(thing: T): T => structuredClone(thing);

	/**
	 * `ai` rebuilds a resumed response from empty state, so a stream that carries
	 * on from the stored message (a transport that is not a replay) would replace
	 * it and drop every part streamed before the disconnect. Put the stored parts
	 * back in front of the new ones. When `ai` seeded its state from the stored
	 * message itself (a retained interrupted state, or a tool call still
	 * streaming its input) the written message already carries them: decide that
	 * once, on the first write, so a later write cannot flip it.
	 */
	private withExtension(message: TMessage): TMessage {
		const extension = this.#extension;
		if (!extension || message.id !== extension.base.id) return message;
		extension.seeded ??= includesParts(message.parts, extension.base.parts);
		if (extension.seeded) return message;
		const { metadata: stored } = extension.base;
		const resumed = message.metadata;
		const metadata =
			resumed === undefined
				? stored
				: typeof stored === "object" && typeof resumed === "object"
					? { ...stored, ...resumed }
					: resumed;
		return {
			...message,
			metadata,
			parts: [...extension.base.parts, ...message.parts],
		};
	}

	private writeMessage(message: TMessage) {
		this.#host.writeRunMessage(this.#spec.id, message);
	}
}

type ResumeAttempt = { foundNoStream: boolean };

export class ThreadRunChat<
	TMessage extends UIMessage,
> extends AbstractChat<TMessage> {
	readonly #replays: boolean;
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
			// the attempt that asked. Once the answer is known the run either goes on
			// to resume (`ai` reports it) or stays as it was; a superseded attempt
			// (a newer `resume` replaced it) leaves the decision to the newer one.
			reconnectToStream: async (options) => {
				const attempt = resumes.current;
				let stream: ReadableStream<UIMessageChunk> | null;
				try {
					stream = await host.transport.reconnectToStream(options);
				} catch (error) {
					if (resumes.current === attempt) state.release();
					throw error;
				}
				if (attempt && resumes.current === attempt) {
					if (stream === null && !options.abortSignal?.aborted) {
						attempt.foundNoStream = true;
					} else {
						state.release();
					}
				}
				return stream;
			},
			resumeStreamIsReplay: host.transport.resumeStreamIsReplay,
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
			// rebuilt around an existing assistant must reuse that assistant's id.
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
		this.#replays = host.transport.resumeStreamIsReplay === true;
		this.#resumes = resumes;
		this.#state = state;
	}

	refreshPath() {
		this.#state.refreshPath();
	}

	/**
	 * `resumeStream` with the two things `ai` 6.0.323 no longer does for a run
	 * resumed from its stored message:
	 *
	 * - A resume that finds no stream ends in status "ready" with the run's error
	 *   cleared. A failed run keeps its error until the caller clears it, so the
	 *   host is told nothing while that is undecided and nothing at all when no
	 *   stream turns up (it never sees "ready"), instead of seeing the error
	 *   vanish and come back.
	 * - A stream that carries on from the stored message (a transport that is not
	 *   a replay) extends that message instead of replacing it.
	 */
	async resume(options?: ChatRequestOptions) {
		const attempt: ResumeAttempt = { foundNoStream: false };
		this.#resumes.current = attempt;
		if (this.error) this.#state.hold();
		const stored = this.lastMessage;
		this.#state.extendResponse(
			!this.#replays && stored?.role === "assistant"
				? structuredClone(stored)
				: undefined,
		);
		try {
			await this.resumeStream(options);
		} finally {
			if (this.#resumes.current === attempt) {
				this.#resumes.current = undefined;
				this.#state.extendResponse(undefined);
				if (attempt.foundNoStream) this.#state.restore();
				else this.#state.release();
			}
		}
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

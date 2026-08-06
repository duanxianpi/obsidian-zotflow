export type WorkerTimeout = ReturnType<typeof setTimeout>;

export function workerSetTimeout(
    callback: () => void,
    delay?: number,
): WorkerTimeout {
    const schedule = setTimeout;
    return schedule(callback, delay);
}

export function workerClearTimeout(timeout: WorkerTimeout | undefined): void {
    const clear = clearTimeout;
    clear(timeout);
}

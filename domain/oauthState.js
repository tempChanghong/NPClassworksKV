// Bounded process-local storage; expiry is enforced on callback, not only cleanup.
export class OAuthStateStore {
    constructor({maxEntries = 1000, ttlMs = 300000, now = Date.now} = {}) {
        this.entries = new Map(); this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now;
    }
    prune() {
        for (const [key, value] of this.entries) if (this.now() - value.timestamp >= this.ttlMs) this.entries.delete(key);
    }
    set(key, value) {
        if (this.entries.size >= this.maxEntries) this.prune();
        if (this.entries.size >= this.maxEntries) return false;
        this.entries.set(key, {...value, timestamp: this.now()});
        return true;
    }
    consume(key, provider, browserBinding) {
        const value = this.entries.get(key);
        if (!value) return null;
        if (this.now() - value.timestamp >= this.ttlMs) {this.entries.delete(key); return null;}
        if (value.provider !== provider || !browserBinding || value.browserBinding !== browserBinding) return null;
        this.entries.delete(key);
        return value;
    }
}

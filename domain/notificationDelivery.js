export function normalizeNotificationDeliveryItems(items, limit = 100) {
    return (Array.isArray(items) ? items : []).map((item) => {
        const acknowledged = item?.acknowledged === true;
        return {
            publicationId: typeof item?.publicationId === "string" ? item.publicationId : "",
            revision: Number(item?.revision),
            displayed: item?.displayed === true || acknowledged,
            acknowledged,
        };
    }).filter((item) => (
        item.publicationId && Number.isInteger(item.revision) && item.revision > 0
    )).slice(0, limit);
}

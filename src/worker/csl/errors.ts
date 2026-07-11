import type { Availability } from "./types";

/**
 * Thrown when rendering is requested for a style whose dependency chain is not
 * closed (missing parent, missing locale, invalid XML, ...). The availability
 * is attached so consumers can tell the user exactly what is missing instead
 * of silently rendering a broken bibliography.
 */
export class UnavailableStyleError extends Error {
	readonly styleId: string;
	readonly availability: Availability;

	constructor(styleId: string, availability: Availability) {
		super(
			`Style "${styleId}" is not ready to render: ${describeAvailability(availability)}`
		);
		this.name = "UnavailableStyleError";
		this.styleId = styleId;
		this.availability = availability;
	}
}

export function describeAvailability(a: Availability): string {
	switch (a.status) {
		case "ready":
			return "ready";
		case "resolvable":
			return "dependencies not downloaded yet (network required)";
		case "unresolved-parent":
			return `independent parent style "${a.parent}" cannot be retrieved`;
		case "unresolved-locale":
			return `locale "${a.locale}" cannot be retrieved`;
		case "missing":
			return "style not found";
		case "invalid":
			return `invalid style: ${a.reason}`;
	}
}

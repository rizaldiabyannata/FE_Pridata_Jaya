import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({ default: { get } }));

const { deliveryOrdersService, rankSourceWarehouses, shippableStock } = await import("./delivery-orders");
const { indexAvailability } = await import("./warehouse-inventory");

const row = (warehouseId: string, productId: string, onHand: number, reservedByActiveDo = 0) => ({
	warehouseId,
	productId,
	onHand,
	reservedByActiveDo,
	available: Math.max(onHand - reservedByActiveDo, 0),
});

const item = (productId: string, quantities: { ordered?: number; picked?: number; packed?: number; shipped?: number }) => ({
	id: `i-${productId}`,
	productId,
	condition: "GOOD" as const,
	orderedQuantity: quantities.ordered ?? 0,
	pickedQuantity: quantities.picked ?? 0,
	packedQuantity: quantities.packed ?? 0,
	shippedQuantity: quantities.shipped ?? 0,
});

describe("deliveryOrdersService", () => {
	beforeEach(() => {
		get.mockReset();
	});

	it("sends a status list as one comma-separated param", async () => {
		const meta = { currentPage: 1, totalPages: 1, totalItems: 1, itemsPerPage: 20 };
		get.mockResolvedValue({ data: { data: [{ id: "do1" }], meta } });

		const result = await deliveryOrdersService.list({
			page: 1,
			limit: 20,
			status: ["SHIPPED", "RECEIVED"],
			search: "budi",
			sourceWarehouseId: "w1",
		});

		expect(get).toHaveBeenCalledWith("/delivery-orders", {
			params: { page: 1, limit: 20, status: "SHIPPED,RECEIVED", search: "budi", sourceWarehouseId: "w1" },
		});
		expect(result).toEqual({ items: [{ id: "do1" }], meta });
	});

	it("passes a single status through unchanged", async () => {
		get.mockResolvedValue({ data: { data: [], meta: undefined } });
		await deliveryOrdersService.list({ status: "SHIPPED" });
		expect(get).toHaveBeenCalledWith("/delivery-orders", { params: { status: "SHIPPED" } });
	});

	it("reads both summaries from /summary with their groupBy", async () => {
		get.mockResolvedValue({ data: { data: [{ warehouseId: "w1" }] } });

		await expect(deliveryOrdersService.summaryByWarehouse({ search: "x" })).resolves.toEqual([{ warehouseId: "w1" }]);
		expect(get).toHaveBeenLastCalledWith("/delivery-orders/summary", { params: { search: "x", groupBy: "warehouse" } });

		await deliveryOrdersService.summaryByDriver();
		expect(get).toHaveBeenLastCalledWith("/delivery-orders/summary", { params: { groupBy: "driver" } });
	});
});

describe("shippableStock", () => {
	it("is 0 when the server returned no row for the pair", () => {
		expect(shippableStock({ items: [] }, "p1", undefined)).toBe(0);
	});

	it("uses the server's available for a DO that holds no stock yet", () => {
		const deliveryOrder = { items: [item("p1", { ordered: 5 })] };
		expect(shippableStock(deliveryOrder, "p1", row("w1", "p1", 10, 4))).toBe(6);
	});

	it("adds back the DO's own picked/packed units while it reserves", () => {
		// 10 on hand, 7 reserved of which 5 are this DO's (max(picked 5, packed 3) - shipped 0).
		const deliveryOrder = { items: [item("p1", { ordered: 5, picked: 5, packed: 3 })] };
		expect(shippableStock(deliveryOrder, "p1", row("w1", "p1", 10, 7))).toBe(8);
	});

	it("only adds back the lines of the asked product, net of what was shipped", () => {
		const deliveryOrder = {
			items: [item("p1", { picked: 6, packed: 6, shipped: 4 }), item("p2", { picked: 9 })],
		};
		// own reservation for p1 = 6 - 4 = 2; reserved 3 → 12 - 3 + 2.
		expect(shippableStock(deliveryOrder, "p1", row("w1", "p1", 12, 3))).toBe(11);
	});

	it("adds back own GOOD lines whatever the status", () => {
		const deliveryOrder = { items: [item("p1", { ordered: 5, picked: 5 })] };
		expect(shippableStock(deliveryOrder, "p1", row("w1", "p1", 10, 5))).toBe(10);
	});

	it("ignores own non-GOOD lines, which the server does not reserve", () => {
		const deliveryOrder = {
			items: [{ ...item("p1", { picked: 4 }), condition: "DAMAGED" as const }],
		};
		expect(shippableStock(deliveryOrder, "p1", row("w1", "p1", 10, 2))).toBe(8);
	});
});

describe("rankSourceWarehouses", () => {
	const warehouses = [
		{ id: "w1", name: "Gudang A" },
		{ id: "w2", name: "Gudang B" },
	];

	it("returns no options for an order without items", () => {
		expect(rankSourceWarehouses([], warehouses, new Map())).toEqual([]);
	});

	it("counts shortfalls per warehouse and sorts by total available", () => {
		const stock = indexAvailability([row("w1", "p1", 2), row("w2", "p1", 10), row("w2", "p2", 1)]);
		const orderItems = [
			{ productId: "p1", condition: "GOOD", quantity: 5 },
			{ productId: "p2", condition: "GOOD", quantity: 1 },
		];

		expect(rankSourceWarehouses(orderItems, warehouses, stock)).toEqual([
			{ id: "w2", name: "Gudang B", shortfallCount: 0, totalAvailable: 11 },
			{ id: "w1", name: "Gudang A", shortfallCount: 2, totalAvailable: 2 },
		]);
	});

	it("treats non-GOOD order lines as unavailable", () => {
		const stock = indexAvailability([row("w1", "p1", 50)]);
		const [option] = rankSourceWarehouses([{ productId: "p1", condition: "DAMAGED", quantity: 1 }], [warehouses[0]], stock);
		expect(option).toMatchObject({ shortfallCount: 1, totalAvailable: 0 });
	});
});

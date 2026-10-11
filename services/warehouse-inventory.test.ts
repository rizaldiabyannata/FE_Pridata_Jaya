import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("@/lib/api-client", () => ({ default: { get } }));

const { warehouseInventoryService, indexAvailability } = await import("./warehouse-inventory");

describe("warehouseInventoryService.availability", () => {
	beforeEach(() => {
		get.mockReset();
	});

	it("asks only for the given products, deduplicated, as one comma list", async () => {
		const rows = [{ productId: "p1", warehouseId: "w1", onHand: 3, reservedByActiveDo: 1, available: 2 }];
		get.mockResolvedValue({ data: { data: rows } });

		await expect(warehouseInventoryService.availability(["p1", "p2", "p1"], "w1", "GOOD")).resolves.toEqual(rows);
		expect(get).toHaveBeenCalledWith("/warehouse-inventories/availability", {
			params: { productIds: "p1,p2", warehouseId: "w1", condition: "GOOD" },
		});
	});

	it("splits more than 200 products into batches and merges the rows", async () => {
		const ids = Array.from({ length: 201 }, (_, index) => `p${index}`);
		get.mockImplementation((...args: unknown[]) => {
			const config = args[1] as { params: { productIds: string } };
			return Promise.resolve({ data: { data: [{ productId: config.params.productIds.split(",")[0] }] } });
		});

		const result = await warehouseInventoryService.availability(ids);

		expect(get).toHaveBeenCalledTimes(2);
		expect(get.mock.calls[0][1].params.productIds.split(",")).toHaveLength(200);
		expect(get.mock.calls[1][1].params).toEqual({ productIds: "p200", warehouseId: undefined, condition: undefined });
		expect(result).toEqual([{ productId: "p0" }, { productId: "p200" }]);
	});

	it("makes no request for an empty product list", async () => {
		await expect(warehouseInventoryService.availability([])).resolves.toEqual([]);
		expect(get).not.toHaveBeenCalled();
	});

	it("indexes rows by warehouse and product", () => {
		const row = { productId: "p1", warehouseId: "w1", onHand: 3, reservedByActiveDo: 0, available: 3 };
		expect(indexAvailability([row]).get("w1:p1")).toBe(row);
	});
});

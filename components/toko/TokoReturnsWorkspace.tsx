"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@/components/shared/Badge";
import Button from "@/components/shared/Button";
import Card from "@/components/shared/Card";
import Modal from "@/components/shared/Modal";
import { fieldClasses } from "@/components/shared/FormInput";
import InlineAlert from "@/components/shared/InlineAlert";
import PageFeedback from "@/components/shared/PageFeedback";
import PaginationControls from "@/components/shared/PaginationControls";
import QuantityStepper from "@/components/shared/QuantityStepper";
import ResponsiveTable, { type ResponsiveColumn } from "@/components/shared/ResponsiveTable";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatAppDateTime } from "@/lib/datetime";
import { formatRupiah } from "@/lib/format";
import { deliveryOrderStatusLabel, returnLifecycleLabel, type StatusTone } from "@/lib/ui-labels";
import { deliveryOrdersService } from "@/services/delivery-orders";
import { invoicesService, type InvoiceListItem } from "@/services/invoices";
import { meService } from "@/services/me";
import { ordersService, type OrderListItem } from "@/services/orders";
import { salesService } from "@/services/sales";
import {
	isReturnEligibleWithin24Hours,
	storeReturnsService,
	type ReturnExcessResolution,
	type StoreReturnItemCondition,
	type StoreReturnRequestItem,
} from "@/services/store-returns";

const RETURN_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 10;

interface TokoReturnsWorkspaceProps {
	storeId: string;
	storeName: string;
	actorMode: "toko" | "sales";
}

interface DraftReturnItem {
	productId: string;
	productName: string;
	qtyPurchased: number;
	qtyGood: string;
	qtyDamaged: string;
}

const buildReferenceDate = (_order: OrderListItem, invoice?: InvoiceListItem | null) =>
	invoice?.deliveryOrder?.status === "RECEIVED" ? invoice.deliveryOrder.receivedAt : null;

const getRemainingHours = (referenceDate?: string | null) => {
	const referenceTime = new Date(String(referenceDate || "")).getTime();
	if (Number.isNaN(referenceTime)) {
		return 0;
	}

	return Math.max(
		0,
		Math.ceil((referenceTime + RETURN_WINDOW_MS - Date.now()) / (60 * 60 * 1000)),
	);
};

const mapDraftItems = (order: OrderListItem): DraftReturnItem[] =>
	(order.items ?? []).map((item) => ({
		productId: item.productId,
		productName: item.product?.name ?? "Produk",
		qtyPurchased: item.quantity,
		qtyGood: "0",
		qtyDamaged: "0",
	}));

const attachDeliveryOrdersToInvoices = async (
	invoices: InvoiceListItem[],
	actorMode: TokoReturnsWorkspaceProps["actorMode"],
) => {
	const enriched = await Promise.all(
		invoices.map(async (invoice) => {
			if (invoice.deliveryOrder) return invoice;
			try {
				const deliveryOrder =
					actorMode === "toko"
						? await deliveryOrdersService.getByInvoiceIdForToko(invoice.id)
						: await deliveryOrdersService.getByInvoiceId(invoice.id);
				return {
					...invoice,
					deliveryOrder: {
						id: deliveryOrder.id,
						deliveryOrderNumber: deliveryOrder.deliveryOrderNumber,
						status: deliveryOrder.status,
						receivedAt: deliveryOrder.receivedAt ?? null,
						receiptNotes: deliveryOrder.receiptNotes ?? null,
						shipments: deliveryOrder.shipments,
					},
				} satisfies InvoiceListItem;
			} catch {
				return invoice;
			}
		}),
	);

	return enriched;
};

const statusLabel: Record<string, string> = {
	PENDING: "Menunggu Verifikasi Gudang",
	PARTIALLY_APPROVED: "Disetujui Sebagian",
	APPROVED_GOOD: "Disetujui - Barang Bagus",
	APPROVED_DAMAGED: "Disetujui - Barang Rusak",
	RETURNED: "Retur Barang Selesai",
	REJECTED: "Ditolak",
};

const resolutionLabel: Record<string, string> = {
	STORE_CREDIT: "Saldo Toko",
	REPLACEMENT: "Barang Pengganti",
	NONE: "Retur Barang Biasa",
};

const statusToneByReturn: Record<string, StatusTone> = {
	PENDING: "warning",
	PARTIALLY_APPROVED: "brand",
	APPROVED_GOOD: "success",
	APPROVED_DAMAGED: "success",
	RETURNED: "success",
	REJECTED: "danger",
};

const tokoConditionLabel: Record<StoreReturnItemCondition, string> = {
	DAMAGED: "Rusak",
	GOOD: "Salah Kirim / Barang Masih Bagus",
};

const getStoreReturnSubmitErrorMessage = (error: unknown) => {
	const message = getApiErrorMessage(error, "Gagal mengajukan retur toko.");

	if (
		message === "Store return can only be requested before invoice payment is recorded" ||
		message === "STORE_RETURN_REQUIRES_UNPAID_INVOICE"
	) {
		return "Retur sekarang mengikuti waktu penerimaan barang. Muat ulang halaman lalu coba lagi.";
	}

	if (
		message === "Store return can only be requested after goods are received" ||
		message === "STORE_RETURN_REQUIRES_RECEIVED_DELIVERY"
	) {
		return "Retur hanya bisa diajukan setelah toko mengonfirmasi barang diterima.";
	}

	if (message === "Store return request window has expired" || message === "STORE_RETURN_WINDOW_EXPIRED") {
		return "Batas pengajuan retur 24 jam sejak barang diterima sudah lewat.";
	}

	return message;
};

export default function TokoReturnsWorkspace({
	actorMode,
	storeId,
}: TokoReturnsWorkspaceProps) {
	const [orders, setOrders] = useState<OrderListItem[]>([]);
	const [invoicesByOrderId, setInvoicesByOrderId] = useState<Record<string, InvoiceListItem>>({});
	const [records, setRecords] = useState<StoreReturnRequestItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const [modalError, setModalError] = useState("");
	const [success, setSuccess] = useState("");
	const [search, setSearch] = useState("");
	const [eligiblePage, setEligiblePage] = useState(1);
	const [historyPage, setHistoryPage] = useState(1);
	const [selectedOrder, setSelectedOrder] = useState<OrderListItem | null>(null);
	const [selectedReturn, setSelectedReturn] = useState<StoreReturnRequestItem | null>(null);
	const [draftItems, setDraftItems] = useState<DraftReturnItem[]>([]);
	const [generalNote, setGeneralNote] = useState("");
	const [returnReason, setReturnReason] = useState("");
	const [excessResolution, setExcessResolution] = useState<ReturnExcessResolution>("STORE_CREDIT");
	const [storeType, setStoreType] = useState<"RETAILER" | "WHOLESALER" | "DISTRIBUTOR">("RETAILER");

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const [orderResult, invoiceResult, returnResult, storeProfile] = await Promise.all([
				actorMode === "sales"
					? ordersService.listAllForSales({
							storeId,
							sortBy: "documentDate",
							sortOrder: "desc",
						})
					: ordersService.listAllForToko({
							sortBy: "documentDate",
							sortOrder: "desc",
						}),
				actorMode === "sales"
					? invoicesService.listAllForSales({
							storeId,
							sortBy: "invoiceDate",
							sortOrder: "desc",
						})
					: invoicesService.listAllForToko({
							sortBy: "invoiceDate",
							sortOrder: "desc",
						}),
				actorMode === "sales"
					? storeReturnsService.listAllForSales({
							storeId,
							sortBy: "submittedAt",
							sortOrder: "desc",
						})
					: storeReturnsService.listAllForToko({
							sortBy: "submittedAt",
							sortOrder: "desc",
						}),
				actorMode === "sales"
					? salesService.getManagedStoreById(storeId).catch(() => null)
					: meService.getProfile().catch(() => null),
			]);

			const enrichedInvoices = await attachDeliveryOrdersToInvoices(invoiceResult, actorMode);

			setOrders(orderResult.filter((item) => item.status === "PROCESSED"));
			setInvoicesByOrderId(Object.fromEntries(enrichedInvoices.map((item) => [item.orderId, item])));
			setRecords(returnResult);
			const resolvedStoreType =
				storeProfile && "storeType" in storeProfile
					? storeProfile.storeType
					: storeProfile && "store" in storeProfile
						? storeProfile.store?.storeType
						: undefined;
			setStoreType(
				resolvedStoreType === "WHOLESALER" || resolvedStoreType === "DISTRIBUTOR"
					? resolvedStoreType
					: "RETAILER",
			);
		} catch (loadError: unknown) {
			setError(getApiErrorMessage(loadError, "Gagal memuat data retur toko."));
		} finally {
			setLoading(false);
		}
	}, [actorMode, storeId]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void load();
		}, 0);

		return () => window.clearTimeout(timer);
	}, [load]);

	const existingReturnMap = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const item of records) {
			if (item.status !== "REJECTED") {
				map.set(item.orderId, true);
			}
		}
		return map;
	}, [records]);

	const handleConfirmReplacement = async (deliveryOrderId: string, deliveryOrderNumber: string) => {
		setError("");
		setSuccess("");
		try {
			await deliveryOrdersService.confirmReceiptForToko(deliveryOrderId);
			setSuccess(`Barang pengganti ${deliveryOrderNumber} berhasil dikonfirmasi diterima.`);
			setSelectedReturn(null);
			await load();
		} catch (confirmError: unknown) {
			setError(getApiErrorMessage(confirmError, "Gagal mengonfirmasi penerimaan barang pengganti."));
		}
	};

	const eligibleOrders = useMemo(() => {
		const query = search.trim().toLowerCase();
		return orders
			.map((order) => {
				const invoice = invoicesByOrderId[order.id];
				const referenceDate = buildReferenceDate(order, invoice);
				return {
					order,
					invoice,
					referenceDate,
					eligible:
						Boolean(invoice) &&
						invoice?.status !== "CANCELLED" &&
						Boolean(referenceDate) &&
						(storeType !== "RETAILER" || isReturnEligibleWithin24Hours(referenceDate)),
					hasExistingReturn: existingReturnMap.has(order.id),
				};
			})
			.filter((item) => item.eligible)
			.filter((item) => {
				if (!query) {
					return true;
				}

				return (
					item.order.orderNumber.toLowerCase().includes(query) ||
					item.order.storeNameSnapshot.toLowerCase().includes(query)
				);
			});
	}, [existingReturnMap, invoicesByOrderId, orders, search, storeType]);

	const groupedHistory = useMemo(
		() =>
			records
				.slice()
				.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt)),
		[records],
	);

	const eligibleTotalPages = Math.max(1, Math.ceil(eligibleOrders.length / PAGE_SIZE));
	const eligibleCurrentPage = Math.min(eligiblePage, eligibleTotalPages);
	const paginatedEligibleOrders = useMemo(() => {
		const start = (eligibleCurrentPage - 1) * PAGE_SIZE;
		return eligibleOrders.slice(start, start + PAGE_SIZE);
	}, [eligibleCurrentPage, eligibleOrders]);

	const historyTotalPages = Math.max(1, Math.ceil(groupedHistory.length / PAGE_SIZE));
	const historyCurrentPage = Math.min(historyPage, historyTotalPages);
	const paginatedHistory = useMemo(() => {
		const start = (historyCurrentPage - 1) * PAGE_SIZE;
		return groupedHistory.slice(start, start + PAGE_SIZE);
	}, [groupedHistory, historyCurrentPage]);
	const selectedInvoice = selectedOrder ? invoicesByOrderId[selectedOrder.id] : undefined;
	const requestedReturnEstimate = useMemo(
		() =>
			draftItems.reduce((total, item) => {
				const quantity = Math.max(0, Number(item.qtyGood) || 0) + Math.max(0, Number(item.qtyDamaged) || 0);
				const invoiceItem = selectedInvoice?.items?.find((candidate) => candidate.productId === item.productId);
				return !invoiceItem || invoiceItem.quantity <= 0
					? total
					: total + Math.round((invoiceItem.subtotal * quantity) / invoiceItem.quantity);
			}, 0),
		[draftItems, selectedInvoice],
	);

	const submitReturn = async () => {
		if (!selectedOrder) {
			return;
		}

		const invoice = invoicesByOrderId[selectedOrder.id];
		if (!invoice) {
			setModalError("Invoice untuk order ini belum tersedia, retur belum bisa diajukan.");
			return;
		}

		const referenceDate = buildReferenceDate(selectedOrder, invoice);
		if (!referenceDate) {
			setModalError("Retur hanya bisa diajukan setelah toko mengonfirmasi barang diterima.");
			return;
		}

		if (storeType === "RETAILER" && !isReturnEligibleWithin24Hours(referenceDate)) {
			setModalError("Batas retur 24 jam untuk transaksi ini sudah lewat.");
			return;
		}

		if (existingReturnMap.has(selectedOrder.id)) {
			setModalError("Retur untuk order ini sudah pernah diajukan dan belum ditolak.");
			return;
		}

		const pickedItems = draftItems
			.flatMap((item) => [
				{
					...item,
					quantity: Math.max(0, Math.floor(Number(item.qtyGood) || 0)),
					condition: "GOOD" as const,
				},
				{
					...item,
					quantity: Math.max(0, Math.floor(Number(item.qtyDamaged) || 0)),
					condition: "DAMAGED" as const,
				},
			])
			.filter((item) => item.quantity > 0);

		if (pickedItems.length === 0) {
			setModalError("Pilih minimal satu item dengan qty retur lebih dari 0.");
			return;
		}

		// Sebelumnya field ini di-default ke kalimat instruksi, jadi tidak pernah
		// kosong — dan setiap retur yang tidak ditimpa terkirim beralasan
		// "Jelaskan alasan retur dari toko". Sekarang kosong, jadi harus dijaga.
		if (!returnReason.trim()) {
			setModalError("Isi alasan retur terlebih dahulu.");
			return;
		}

		for (const item of draftItems) {
			const totalReturn =
				Math.max(0, Math.floor(Number(item.qtyGood) || 0)) +
				Math.max(0, Math.floor(Number(item.qtyDamaged) || 0));
			if (totalReturn > item.qtyPurchased) {
				setModalError(`Total qty retur ${item.productName} melebihi qty beli.`);
				return;
			}
		}

		setSubmitting(true);
		setModalError("");
		setSuccess("");

		try {
			const payload = {
				invoiceId: invoice.id,
				reason: returnReason.trim(),
				note: generalNote.trim() || undefined,
				excessResolution: invoice.paidAmount > 0 ? excessResolution : undefined,
				items: pickedItems.map((item) => ({
					productId: item.productId,
					quantity: item.quantity,
					requestedCondition: item.condition,
				})),
			};
			if (actorMode === "sales") {
				await storeReturnsService.createForSales({
					storeId,
					...payload,
				});
			} else {
				await storeReturnsService.createForToko(payload);
			}

			setSuccess("Pengajuan retur berhasil dikirim dan menunggu verifikasi gudang.");
			setSelectedOrder(null);
			setDraftItems([]);
			setGeneralNote("");
			await load();
		} catch (submitError: unknown) {
			setModalError(getStoreReturnSubmitErrorMessage(submitError));
		} finally {
			setSubmitting(false);
		}
	};

	const eligibleColumns: ResponsiveColumn<(typeof paginatedEligibleOrders)[number]>[] = [
		{
			key: "order",
			head: "Order",
			role: "title",
			render: ({ order }) => (
				<span className="block">
					<span className="block font-medium text-slate-900">{order.orderNumber}</span>
					<span className="block text-xs text-slate-500">{order.storeNameSnapshot}</span>
				</span>
			),
		},
		{
			key: "window",
			head: "Ketentuan Retur",
			role: "status",
			render: ({ referenceDate }) => (
				<Badge tone={storeType === "RETAILER" ? "warning" : "neutral"}>
					{storeType === "RETAILER"
						? `${getRemainingHours(referenceDate)} jam tersisa`
						: "-"}
				</Badge>
			),
		},
		{
			key: "amount",
			head: "Nilai Invoice",
			role: "amount",
			align: "right",
			render: ({ invoice, order }) => formatRupiah(invoice?.totalAmount ?? order.totalAmount),
		},
		{
			key: "referenceDate",
			head: "Tanggal Referensi",
			render: ({ referenceDate }) => formatAppDateTime(referenceDate),
		},
		{
			key: "action",
			head: "Aksi",
			role: "action",
			align: "right",
			render: ({ order, hasExistingReturn }) => (
				<Button
					variant="danger"
					size="sm"
					disabled={hasExistingReturn}
					onClick={() => {
						setSelectedOrder(order);
						setDraftItems(mapDraftItems(order));
						setGeneralNote("");
						setModalError("");
						setReturnReason("Jelaskan alasan retur dari toko");
						setExcessResolution("STORE_CREDIT");
					}}
				>
					{hasExistingReturn ? "Sudah Diajukan" : "Ajukan Retur"}
				</Button>
			),
		},
	];

	const historyColumns: ResponsiveColumn<StoreReturnRequestItem>[] = [
		{ key: "requestNumber", head: "No Request", role: "title" },
		{
			key: "status",
			head: "Status",
			role: "status",
			render: (request) => (
				<div>
					<Badge tone={statusToneByReturn[request.status] ?? "neutral"}>
						{statusLabel[request.status] ?? request.status}
					</Badge>
					{/* "Disetujui" saja tidak cukup: toko perlu tahu masih menunggu akuntan atau sudah selesai. */}
					{request.lifecycleStatus && request.status !== "PENDING" && request.status !== "REJECTED" ? (
						<p className="mt-1 text-xs text-slate-500">{returnLifecycleLabel[request.lifecycleStatus]}</p>
					) : null}
				</div>
			),
		},
		{ key: "invoice", head: "Invoice", render: (request) => request.invoice?.invoiceNumber ?? "-" },
		{
			key: "submittedAt",
			head: "Tanggal",
			render: (request) => formatAppDateTime(request.submittedAt),
		},
		{
			key: "action",
			head: "Aksi",
			role: "action",
			align: "right",
			render: (request) => (
				<Button variant="secondary" size="sm" onClick={() => setSelectedReturn(request)}>
					Detail
				</Button>
			),
		},
	];

	const returnItemColumns: ResponsiveColumn<StoreReturnRequestItem["items"][number]>[] = [
		{ key: "productNameSnapshot", head: "Barang", role: "title" },
		{ key: "quantity", head: "Diajukan", role: "amount", align: "right" },
		{
			key: "receivedQuantity",
			head: "Diterima",
			align: "right",
			render: (item) => item.receivedQuantity ?? 0,
		},
		{
			key: "rejectedQuantity",
			head: "Ditolak",
			align: "right",
			render: (item) => (
				<span className="font-medium text-rose-700">
					{Math.max(0, item.quantity - (item.receivedQuantity ?? 0))}
				</span>
			),
		},
		{
			key: "requestedCondition",
			head: "Klasifikasi Toko",
			render: (item) => tokoConditionLabel[item.requestedCondition] ?? item.requestedCondition,
		},
		{
			key: "approvedCondition",
			head: "Hasil Gudang",
			render: (item) => (item.approvedCondition ? tokoConditionLabel[item.approvedCondition] : "-"),
		},
		{
			key: "warehouseNotes",
			head: "Catatan Hasil",
			render: (item) => item.warehouseNotes || "-",
		},
	];

	return (
		<>
			<PageFeedback
				error={error}
				success={success}
				onDismissError={() => setError("")}
				onDismissSuccess={() => setSuccess("")}
			/>

			<Card>
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div>
						<h2 className="type-title text-slate-900">Transaksi Eligible Retur</h2>
						<p className="type-body mt-1 text-slate-600">
							Transaksi harus sudah diterima dan belum punya retur aktif. Batas 24 jam hanya
							berlaku untuk toko retail.
						</p>
					</div>
					<input
						className={fieldClasses("control", "md:w-72")}
						placeholder="Cari nomor order"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setEligiblePage(1);
						}}
					/>
				</div>
				<div className="mt-4">
					<ResponsiveTable
						columns={eligibleColumns}
						data={paginatedEligibleOrders}
						getRowKey={({ order }) => order.id}
						loading={loading}
						emptyText="Tidak ada transaksi yang masih eligible retur"
						emptyDescription="Retur hanya bisa diajukan untuk pesanan yang masih dalam masa ketentuan."
					/>
				</div>
				<PaginationControls
					currentPage={eligibleCurrentPage}
					totalPages={eligibleTotalPages}
					totalItems={eligibleOrders.length}
					currentItemCount={paginatedEligibleOrders.length}
					pageSize={PAGE_SIZE}
					itemLabel="pesanan"
					onPageChange={setEligiblePage}
				/>
			</Card>

			<section className="space-y-3">
				<h2 className="type-title text-slate-900">
					Riwayat Pengajuan Retur
				</h2>
				<ResponsiveTable
					columns={historyColumns}
					data={paginatedHistory}
					getRowKey={(request) => request.id}
					loading={loading}
					onRowClick={(request) => setSelectedReturn(request)}
					emptyText="Belum ada pengajuan retur"
					emptyDescription="Pengajuan yang Anda kirim akan muncul di sini beserta statusnya."
				/>
				<PaginationControls
					currentPage={historyCurrentPage}
					totalPages={historyTotalPages}
					totalItems={groupedHistory.length}
					currentItemCount={paginatedHistory.length}
					pageSize={PAGE_SIZE}
					itemLabel="retur"
					onPageChange={setHistoryPage}
				/>
			</section>

			<Modal
				isOpen={Boolean(selectedReturn)}
				onClose={() => setSelectedReturn(null)}
				title="Detail Retur"
				maxWidthClassName="max-w-4xl"
			>
				{selectedReturn ? (
					<div className="space-y-5 text-sm text-slate-700">
						<div className="grid gap-3 md:grid-cols-2">
							{[
								{ label: "No Request", value: selectedReturn.requestNumber ?? "-" },
								{ label: "Invoice", value: selectedReturn.invoice?.invoiceNumber ?? "-" },
								{ label: "Tanggal Pengajuan", value: formatAppDateTime(selectedReturn.submittedAt) },
								{ label: "Status", value: statusLabel[selectedReturn.status] ?? selectedReturn.status },
								{
									label: "Tahap",
									value: returnLifecycleLabel[selectedReturn.lifecycleStatus ?? ""] ?? "-",
								},
								{ label: "Nilai Retur Disetujui", value: formatRupiah(selectedReturn.approvedAmount) },
								{ label: "Penyesuaian Tagihan Retur", value: formatRupiah(selectedReturn.invoiceAdjustmentAmount) },
								{ label: "Saldo Toko", value: formatRupiah(selectedReturn.storeCreditAmount) },
								{
									label: "Penyelesaian",
									// Hasil akhir bila sudah diputuskan; sebelum itu, pilihan toko.
									value: resolutionLabel[selectedReturn.finalResolution ?? selectedReturn.excessResolution ?? "STORE_CREDIT"],
								},
								{ label: "Jumlah Item", value: `${selectedReturn.items.length} item` },
							].map((item) => (
								<div key={item.label} className="rounded-xl border border-slate-200 p-4">
									<p className="type-label text-slate-500">
										{item.label}
									</p>
									<p className="mt-2 font-semibold text-slate-900">{item.value}</p>
								</div>
							))}
						</div>

						{selectedReturn.creditRejectionReason ? (
							<div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
								<p className="type-label text-amber-700">Saldo toko tidak disetujui, diganti barang</p>
								<p className="mt-2">{selectedReturn.creditRejectionReason}</p>
							</div>
						) : null}

						{selectedReturn.replacementDeliveryOrder ? (
							<div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
								<p className="type-label text-sky-700">Delivery Order Pengganti</p>
								<p className="mt-2 font-semibold">{selectedReturn.replacementDeliveryOrder.deliveryOrderNumber}</p>
								<p className="mt-1 text-xs">Status: {deliveryOrderStatusLabel[selectedReturn.replacementDeliveryOrder.status] ?? selectedReturn.replacementDeliveryOrder.status}</p>
								{selectedReturn.replacementDeliveryOrder.status === "SHIPPED" ? (
									<Button className="mt-3" size="sm" onClick={() => void handleConfirmReplacement(selectedReturn.replacementDeliveryOrder!.id, selectedReturn.replacementDeliveryOrder!.deliveryOrderNumber)}>
										Konfirmasi Barang Pengganti Diterima
									</Button>
								) : null}
							</div>
						) : null}

						<ResponsiveTable
							columns={returnItemColumns}
							data={selectedReturn.items}
							getRowKey={(item) => item.id}
							emptyText="Tidak ada barang pada retur ini"
						/>

						<div className="grid gap-3 md:grid-cols-2">
							<div className="rounded-xl border border-slate-200 p-4">
								<p className="type-label text-slate-500">
									Alasan Retur
								</p>
								<p className="mt-2 whitespace-pre-wrap text-slate-700">{selectedReturn.reason || "-"}</p>
							</div>
							<div className="rounded-xl border border-slate-200 p-4">
								<p className="type-label text-slate-500">
									Catatan Review
								</p>
								<p className="mt-2 whitespace-pre-wrap text-slate-700">
									{selectedReturn.reviewNote || selectedReturn.note || "-"}
								</p>
							</div>
						</div>
					</div>
				) : null}
			</Modal>

			<Modal
				isOpen={Boolean(selectedOrder)}
				onClose={() => {
					setSelectedOrder(null);
					setDraftItems([]);
					setModalError("");
				}}
				title="Ajukan Retur Toko"
			>
				{selectedOrder ? (
					<div className="space-y-4">
						<div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
							<p className="font-semibold text-slate-900">{selectedOrder.orderNumber}</p>
							<p className="mt-1">
								{storeType === "RETAILER"
									? `Batas retur: ${getRemainingHours(
											buildReferenceDate(selectedOrder, invoicesByOrderId[selectedOrder.id]),
										)} jam lagi`
									: "-"}
							</p>
						</div>
						<div className="grid gap-3 sm:grid-cols-3">
							<div className="rounded-xl border border-slate-200 p-3">
								<p className="text-xs text-slate-500">Nilai Invoice</p>
								<p className="mt-1 font-semibold text-slate-900">{formatRupiah(selectedInvoice?.totalAmount ?? 0)}</p>
							</div>
							<div className="rounded-xl border border-slate-200 p-3">
								<p className="text-xs text-slate-500">Sudah Dibayar</p>
								<p className="mt-1 font-semibold text-slate-900">{formatRupiah(selectedInvoice?.paidAmount ?? 0)}</p>
							</div>
							<div className="rounded-xl border border-slate-200 p-3">
								<p className="text-xs text-slate-500">Estimasi Nilai Retur</p>
								<p className="mt-1 font-semibold text-slate-900">{formatRupiah(requestedReturnEstimate)}</p>
							</div>
						</div>
						{(selectedInvoice?.paidAmount ?? 0) > 0 ? (
							<fieldset className="rounded-xl border border-slate-200 p-4">
								<legend className="px-1 text-sm font-semibold text-slate-900">
									Jika ada kelebihan setelah tagihan dipotong
								</legend>
								<p className="mt-1 text-xs text-slate-500">
									Pilihan terkunci setelah dikirim. Hasil akhir mengikuti qty yang diterima Gudang.
								</p>
								<div className="mt-3 grid gap-3 sm:grid-cols-2">
									{(
										[
											["STORE_CREDIT", "Saldo Toko", "Kelebihan nilai retur menjadi kredit untuk pesanan berikutnya."],
											["REPLACEMENT", "Barang Pengganti", "Produk dan qty yang diterima Gudang dibuatkan DO pengganti."],
										] as const
									).map(([value, label, description]) => (
										<button
											key={value}
											type="button"
											aria-pressed={excessResolution === value}
											onClick={() => setExcessResolution(value)}
											className={`min-h-11 rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 ${
												excessResolution === value ? "border-brand-600 bg-brand-50" : "border-slate-200 bg-white hover:bg-slate-50"
											}`}
										>
											<span className="block font-semibold text-slate-900">{label}</span>
											<span className="mt-1 block text-xs text-slate-600">{description}</span>
										</button>
									))}
								</div>
							</fieldset>
						) : (
							<div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
								Belum ada pembayaran terverifikasi. Retur ini diproses sebagai retur barang biasa setelah
								disetujui Gudang: tagihan disesuaikan sesuai barang yang diterima, tanpa saldo toko atau
								barang pengganti.
							</div>
						)}
						<label className="block space-y-2">
							<span className="block text-sm font-medium text-slate-700">Alasan Umum</span>
							<input
								className={fieldClasses("control")}
								value={returnReason}
								onChange={(event) => setReturnReason(event.target.value)}
								placeholder="Contoh: barang rusak saat diterima, atau salah kirim ukuran/jenis"
							/>
						</label>
						<label className="block space-y-2">
							<span className="block text-sm font-medium text-slate-700">Catatan Umum</span>
							<textarea
								className={fieldClasses("area")}
								value={generalNote}
								onChange={(event) => setGeneralNote(event.target.value)}
							/>
						</label>
						{/*
						 * Empat kolom dengan dua input angka per baris tidak muat di HP.
						 * Tiap barang jadi kartu dengan stepper berlabel.
						 */}
						<ul className="space-y-3">
							{draftItems.map((item, index) => (
								<li
									key={`${item.productId}-${index}`}
									className="rounded-xl border border-slate-200 bg-white p-3"
								>
									<div className="flex items-start justify-between gap-3">
										<p className="type-body min-w-0 font-semibold text-slate-900">
											{item.productName}
										</p>
										<span className="type-body shrink-0 text-slate-500">
											Beli {item.qtyPurchased}
										</span>
									</div>
									<div className="mt-3 grid gap-3 sm:grid-cols-2">
										<label className="space-y-1.5">
											<span className="block type-label text-slate-500">
												Qty baik / salah kirim
											</span>
											<QuantityStepper
												label="Qty baik atau salah kirim"
												min={0}
												max={item.qtyPurchased}
												value={Number(item.qtyGood) || 0}
												onChange={(next) =>
													setDraftItems((current) =>
														current.map((row, rowIndex) =>
															rowIndex === index ? { ...row, qtyGood: String(next) } : row,
														),
													)
												}
											/>
										</label>
										<label className="space-y-1.5">
											<span className="block type-label text-slate-500">
												Qty rusak
											</span>
											<QuantityStepper
												label="Qty rusak"
												min={0}
												max={item.qtyPurchased}
												value={Number(item.qtyDamaged) || 0}
												onChange={(next) =>
													setDraftItems((current) =>
														current.map((row, rowIndex) =>
															rowIndex === index ? { ...row, qtyDamaged: String(next) } : row,
														),
													)
												}
											/>
										</label>
									</div>
								</li>
							))}
						</ul>
						{modalError ? <InlineAlert>{modalError}</InlineAlert> : null}
						<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button variant="secondary" onClick={() => setSelectedOrder(null)}>
								Batal
							</Button>
							<Button onClick={() => void submitReturn()} disabled={submitting}>
								{submitting ? "Mengirim..." : "Kirim Pengajuan"}
							</Button>
						</div>
					</div>
				) : null}
			</Modal>
		</>
	);
}

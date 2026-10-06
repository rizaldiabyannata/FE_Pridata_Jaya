"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@/components/shared/Badge";
import Button from "@/components/shared/Button";
import Modal from "@/components/shared/Modal";
import PageFeedback from "@/components/shared/PageFeedback";
import Card from "@/components/shared/Card";
import { fieldClasses } from "@/components/shared/FormInput";
import PaginationControls from "@/components/shared/PaginationControls";
import ResponsiveTable, { type ResponsiveColumn } from "@/components/shared/ResponsiveTable";
import TokoFeatureLayout from "@/components/toko/TokoFeatureLayout";
import { getApiErrorMessage } from "@/lib/api-errors";
import { formatAppDate } from "@/lib/datetime";
import { formatRupiah } from "@/lib/format";
import type { StatusTone } from "@/lib/ui-labels";
import { deliveryOrdersService } from "@/services/delivery-orders";
import { invoicesService, type InvoiceListItem } from "@/services/invoices";
import { ordersService, type OrderListItem } from "@/services/orders";

const dateOnly = (value?: string | null) => (value ? formatAppDate(value) : "-");

const PAGE_SIZE = 10;

type DisplayStatusKey = "FACTURIS" | "GUDANG" | "SHIPPED" | "RECEIVED" | "CANCELLED";

type WorkspaceProps = {
	basePath?: string;
	storeId?: string;
	profileName?: string;
	profileRoleLabel?: string;
	salesName?: string | null;
};

type DeliveryOrderFulfillment = {
	id: string;
	status:
		| "OPEN"
		| "PICKING"
		| "PACKING"
		| "READY_TO_SHIP"
		| "PARTIALLY_SHIPPED"
		| "SHIPPED"
		| "RECEIVED"
		| "CANCELLED";
	receivedAt?: string | null;
	receiptNotes?: string | null;
};

type TransactionRow = {
	id: string;
	kind: "ORDER" | "REPLACEMENT";
	orderNumber: string;
	returnNumber?: string | null;
	invoiceId?: string | null;
	invoiceNumber: string;
	documentDate: string;
	totalAmount: number;
	paidAmount: number;
	remainingAmount: number;
	invoiceStatus?: string | null;
	statusKey: DisplayStatusKey;
	statusLabel: string;
	note: string;
	deliveryOrderId?: string | null;
	canConfirmReceipt: boolean;
	items: Array<{ id: string; product?: { name: string } | null; productNameSnapshot?: string | null; quantity: number; unitPriceSnapshot: number; subtotal?: number | null }>;
};

// Tahapan alur pesanan; nadanya semantik, bukan hue per status.
const statusToneByStage: Record<DisplayStatusKey, StatusTone> = {
	FACTURIS: "warning",
	GUDANG: "brand",
	SHIPPED: "brand",
	RECEIVED: "success",
	CANCELLED: "neutral",
};

const statusOptions: Array<{ value: DisplayStatusKey; label: string }> = [
	{ value: "FACTURIS", label: "Pesanan diproses fakturis" },
	{ value: "GUDANG", label: "Pesanan diproses gudang" },
	{ value: "SHIPPED", label: "Pesanan sedang dalam pengiriman" },
	{ value: "RECEIVED", label: "Pesanan sudah diterima toko" },
	{ value: "CANCELLED", label: "Pesanan dibatalkan" },
];

const deriveTransactionStatus = (
	order: OrderListItem,
	invoice: InvoiceListItem | null,
	deliveryOrder: DeliveryOrderFulfillment | null,
): Pick<TransactionRow, "statusKey" | "statusLabel"> => {
	if (order.status === "CANCELLED") {
		return { statusKey: "CANCELLED", statusLabel: "Pesanan dibatalkan" };
	}

	if (order.status === "PENDING") {
		return { statusKey: "FACTURIS", statusLabel: "Pesanan diproses fakturis" };
	}

	if (deliveryOrder?.status === "RECEIVED") {
		return { statusKey: "RECEIVED", statusLabel: "Pesanan sudah diterima toko" };
	}

	if (deliveryOrder) {
		if (deliveryOrder.status === "SHIPPED") {
			return { statusKey: "SHIPPED", statusLabel: "Pesanan sedang dalam pengiriman" };
		}
		return {
			statusKey: "GUDANG",
			statusLabel: "Pesanan diproses gudang",
		};
	}

	if (invoice?.deliveryOrder?.status === "RECEIVED") {
		return { statusKey: "RECEIVED", statusLabel: "Pesanan sudah diterima toko" };
	}

	if (invoice?.deliveryOrder) {
		if (invoice.deliveryOrder.status === "SHIPPED") {
			return { statusKey: "SHIPPED", statusLabel: "Pesanan sedang dalam pengiriman" };
		}
		return {
			statusKey: "GUDANG",
			statusLabel: "Pesanan diproses gudang",
		};
	}

	if (invoice) {
		return { statusKey: "GUDANG", statusLabel: "Pesanan diproses gudang" };
	}

	return { statusKey: "FACTURIS", statusLabel: "Pesanan diproses fakturis" };
};

export default function TokoTransactionHistoryWorkspace({
	basePath = "/toko",
	storeId,
	profileName,
	profileRoleLabel,
	salesName,
}: WorkspaceProps) {
	const [orders, setOrders] = useState<OrderListItem[]>([]);
	const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
	const [deliveryOrdersByInvoiceId, setDeliveryOrdersByInvoiceId] = useState<Record<string, DeliveryOrderFulfillment | null>>({});
	const [replacementDeliveries, setReplacementDeliveries] = useState<Awaited<ReturnType<typeof deliveryOrdersService.listReplacementHistory>>>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	const [search, setSearch] = useState("");
	const [filterStatus, setFilterStatus] = useState<DisplayStatusKey | "">("");
	const [filterKind, setFilterKind] = useState<"" | TransactionRow["kind"]>("");
	const [page, setPage] = useState(1);
	const [selectedRow, setSelectedRow] = useState<TransactionRow | null>(null);

	const loadData = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const [orderResult, invoiceResult, replacementResult] = await Promise.all(
				storeId
					? [
							ordersService.listAllForSales({ storeId }),
							invoicesService.listAllForSales({ storeId }),
							deliveryOrdersService.listReplacementHistory(storeId),
						]
					: [ordersService.listAllForToko(), invoicesService.listAllForToko(), deliveryOrdersService.listReplacementHistory()],
			);
			setOrders(orderResult);
			setInvoices(invoiceResult);
			setReplacementDeliveries(replacementResult);
			const deliveryOrderEntries = await Promise.all(
				invoiceResult.map(async (invoice) => {
					if (invoice.deliveryOrder) {
						return [invoice.id, invoice.deliveryOrder] as const;
					}
					try {
						const deliveryOrder = await deliveryOrdersService.getByInvoiceIdForToko(invoice.id);
						return [invoice.id, deliveryOrder] as const;
					} catch {
						return [invoice.id, null] as const;
					}
				}),
			);
			setDeliveryOrdersByInvoiceId(Object.fromEntries(deliveryOrderEntries));
		} catch (loadError: unknown) {
			setError(getApiErrorMessage(loadError, "Gagal memuat riwayat transaksi."));
		} finally {
			setLoading(false);
		}
	}, [storeId]);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void loadData();
		}, 0);
		return () => window.clearTimeout(timer);
	}, [loadData]);

	const rows = useMemo(() => {
		const invoiceByOrderId = new Map(invoices.map((invoice) => [invoice.orderId, invoice]));
		const orderRows = orders.map((order): TransactionRow => {
			const invoice = invoiceByOrderId.get(order.id) ?? null;
			const deliveryOrder = invoice ? deliveryOrdersByInvoiceId[invoice.id] ?? invoice.deliveryOrder ?? null : null;
			const status = deriveTransactionStatus(order, invoice, deliveryOrder);
			return {
				id: order.id,
				kind: "ORDER",
				orderNumber: order.orderNumber,
				invoiceId: invoice?.id ?? null,
				invoiceNumber: invoice?.invoiceNumber ?? "-",
				documentDate: order.documentDate,
				totalAmount: order.totalAmount,
				paidAmount: invoice?.paidAmount ?? 0,
				remainingAmount: invoice?.remainingAmount ?? order.totalAmount,
				invoiceStatus: invoice?.status ?? null,
				statusKey: status.statusKey,
				statusLabel: status.statusLabel,
				items: (order.items ?? []).map((item) => ({ ...item, subtotal: item.subtotal ?? item.quantity * item.unitPriceSnapshot })),
				deliveryOrderId: deliveryOrder?.id ?? null,
				canConfirmReceipt:
					deliveryOrder?.status === "SHIPPED",
				note:
					order.cancelReason ||
					order.notes ||
					deliveryOrder?.receiptNotes ||
					invoice?.notes ||
					"-",
			};
		});
		const replacementRows = replacementDeliveries.map((delivery): TransactionRow => ({
			id: `replacement-${delivery.id}`,
			kind: "REPLACEMENT",
			orderNumber: delivery.deliveryOrderNumber,
			returnNumber: delivery.replacementForReturn?.returnNumber ?? null,
			invoiceId: null,
			invoiceNumber: "-",
			documentDate: delivery.documentDate,
			totalAmount: 0,
			paidAmount: 0,
			remainingAmount: 0,
			invoiceStatus: null,
			statusKey: delivery.status === "RECEIVED" ? "RECEIVED" : delivery.status === "SHIPPED" ? "SHIPPED" : delivery.status === "CANCELLED" ? "CANCELLED" : "GUDANG",
			statusLabel: delivery.status === "RECEIVED" ? "Barang pengganti sudah diterima" : delivery.status === "SHIPPED" ? "Barang pengganti sedang dikirim" : delivery.status === "CANCELLED" ? "DO pengganti dibatalkan" : "Barang pengganti diproses gudang",
			note: delivery.receiptNotes || delivery.notes || delivery.replacementForReturn?.reason || "-",
			deliveryOrderId: delivery.id,
			canConfirmReceipt: delivery.status === "SHIPPED",
			items: delivery.items.map((item) => ({ id: item.id, product: item.product, quantity: item.orderedQuantity, unitPriceSnapshot: 0, subtotal: 0 })),
		}));
		return [...orderRows, ...replacementRows].sort((left, right) => new Date(right.documentDate).getTime() - new Date(left.documentDate).getTime());
	}, [deliveryOrdersByInvoiceId, invoices, orders, replacementDeliveries]);

	const handleConfirmReceipt = async (row: TransactionRow) => {
		if (!row.deliveryOrderId) return;
		setError("");
		setSuccess("");
		try {
			await deliveryOrdersService.confirmReceiptForToko(row.deliveryOrderId);
			setSuccess(`Penerimaan barang untuk ${row.kind === "REPLACEMENT" ? "DO pengganti" : "pesanan"} ${row.orderNumber} berhasil dikonfirmasi.`);
			setSelectedRow(null);
			await loadData();
		} catch (confirmError: unknown) {
			setError(getApiErrorMessage(confirmError, "Gagal mengonfirmasi penerimaan barang."));
		}
	};

	const filteredRows = useMemo(() => {
		let result = rows;
		if (filterStatus) {
			result = result.filter((row) => row.statusKey === filterStatus);
		}
		if (filterKind) {
			result = result.filter((row) => row.kind === filterKind);
		}
		if (search.trim()) {
			const query = search.trim().toLowerCase();
			result = result.filter(
				(row) =>
					row.orderNumber.toLowerCase().includes(query) ||
					(row.returnNumber ?? "").toLowerCase().includes(query) ||
					row.items.some((item) => (item.product?.name ?? item.productNameSnapshot ?? "").toLowerCase().includes(query)),
			);
		}
		return result;
	}, [filterKind, filterStatus, rows, search]);
	const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
	const currentPage = Math.min(page, totalPages);
	const paginatedRows = useMemo(() => {
		const start = (currentPage - 1) * PAGE_SIZE;
		return filteredRows.slice(start, start + PAGE_SIZE);
	}, [currentPage, filteredRows]);

	const columns: ResponsiveColumn<(typeof paginatedRows)[number]>[] = [
		{ key: "orderNumber", head: "Referensi", role: "title", render: (row) => <div><p className="font-medium">{row.orderNumber}</p>{row.kind === "REPLACEMENT" ? <p className="text-xs text-sky-700">Pengiriman Barang Pengganti Retur {row.returnNumber ?? "-"}</p> : null}</div> },
		{
			key: "status",
			head: "Status Pesanan",
			role: "status",
			render: (row) => <Badge tone={statusToneByStage[row.statusKey]}>{row.statusLabel}</Badge>,
		},
		{
			key: "totalAmount",
			head: "Total",
			role: "amount",
			align: "right",
			render: (row) => (row.kind === "REPLACEMENT" ? "-" : formatRupiah(row.totalAmount)),
		},
		{ key: "documentDate", head: "Tanggal", render: (row) => dateOnly(row.documentDate) },
		{
			key: "action",
			head: "Aksi",
			role: "action",
			align: "right",
			render: (row) => (
				<Button variant="secondary" size="sm" onClick={() => setSelectedRow(row)}>
					Detail
				</Button>
			),
		},
	];

	return (
		<TokoFeatureLayout
			title="Riwayat Transaksi"
			basePath={basePath}
			profileName={profileName}
			profileRoleLabel={profileRoleLabel}
			salesName={salesName}
		>
			<PageFeedback
				error={error}
				success={success}
				onDismissError={() => setError("")}
				onDismissSuccess={() => setSuccess("")}
			/>

			<Card>
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div>
						<h2 className="type-title text-slate-900">Riwayat Transaksi</h2>
						<p className="type-body mt-1 text-slate-600">
							Halaman ini menampilkan perjalanan pesanan toko. Status tagihan dibuka terpisah di menu
							Tagihan, dan halaman ini tidak lagi menganggap invoice lunas sebagai bukti barang sudah diterima.
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<input
							className={fieldClasses("control", "md:w-56")}
							type="search"
							aria-label="Cari nomor pesanan"
							placeholder="Cari nomor pesanan"
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setPage(1);
							}}
						/>
						<select
							className={fieldClasses("control", "md:w-48")}
							aria-label="Saring status transaksi"
							value={filterStatus}
							onChange={(event) => {
								setFilterStatus((event.target.value as DisplayStatusKey | "") || "");
								setPage(1);
							}}
						>
							<option value="">Semua Status</option>
							{statusOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
						<select
							className={fieldClasses("control", "md:w-48")}
							aria-label="Saring jenis transaksi"
							value={filterKind}
							onChange={(event) => {
								setFilterKind((event.target.value as "" | TransactionRow["kind"]) || "");
								setPage(1);
							}}
						>
							<option value="">Semua Jenis</option>
							<option value="ORDER">Pesanan Reguler</option>
							<option value="REPLACEMENT">Barang Pengganti Retur</option>
						</select>
					</div>
				</div>
			</Card>

			<section className="space-y-3">
				<ResponsiveTable
					columns={columns}
					data={paginatedRows}
					getRowKey={(row) => row.id}
					loading={loading}
					onRowClick={(row) => setSelectedRow(row)}
					emptyText="Tidak ada riwayat transaksi"
					emptyDescription="Coba ubah kata kunci atau filter status di atas."
				/>
				<PaginationControls
					currentPage={currentPage}
					totalPages={totalPages}
					totalItems={filteredRows.length}
					currentItemCount={paginatedRows.length}
					pageSize={PAGE_SIZE}
					itemLabel="transaksi"
					loading={loading}
					onPageChange={setPage}
				/>
			</section>

			<Modal
				isOpen={Boolean(selectedRow)}
				onClose={() => setSelectedRow(null)}
				title="Detail Transaksi"
			>
				{selectedRow ? (
					<div className="space-y-5 text-sm text-slate-700">
						<div className="grid gap-3 md:grid-cols-2">
							{(selectedRow.kind === "REPLACEMENT"
								? [
										{ label: "Nomor DO Pengganti", value: selectedRow.orderNumber },
										{ label: "Nomor Retur", value: selectedRow.returnNumber ?? "-" },
										{ label: "Tanggal", value: dateOnly(selectedRow.documentDate) },
										{ label: "Status Pengiriman", value: selectedRow.statusLabel },
									]
								: [
										{ label: "Nomor Pesanan", value: selectedRow.orderNumber },
										{ label: "Nomor Invoice", value: selectedRow.invoiceNumber },
										{ label: "Tanggal", value: dateOnly(selectedRow.documentDate) },
										{ label: "Status Pesanan", value: selectedRow.statusLabel },
										{ label: "Total Tagihan", value: formatRupiah(selectedRow.totalAmount) },
										{ label: "Sudah Dibayar", value: formatRupiah(selectedRow.paidAmount) },
										{ label: "Sisa Tagihan", value: formatRupiah(selectedRow.remainingAmount) },
										{ label: "Status Invoice", value: selectedRow.invoiceStatus || "-" },
									]
							).map((item) => (
								<div key={item.label} className="rounded-xl border border-slate-200 p-4">
									<p className="type-label text-slate-500">
										{item.label}
									</p>
									<p className="mt-2 font-semibold text-slate-900">{item.value}</p>
								</div>
							))}
						</div>
						<section className="overflow-hidden rounded-xl border border-slate-200">
							<div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
								<h3 className="font-semibold text-slate-900">{selectedRow.kind === "REPLACEMENT" ? "Barang Pengganti" : "Item Pesanan"}</h3>
							</div>
							{selectedRow.items.length === 0 ? (
								<p className="px-4 py-5 text-sm text-slate-500">Rincian item pesanan tidak tersedia.</p>
							) : (
								<ul className="divide-y divide-slate-100">
									{selectedRow.items.map((item) => (
										<li key={item.id} className="flex items-start justify-between gap-3 px-4 py-3">
											<div className="min-w-0">
												<p className="font-medium text-slate-900">
													{item.product?.name ?? item.productNameSnapshot ?? "Produk"}
												</p>
												<p className="mt-0.5 text-xs text-slate-500">
													{selectedRow.kind === "REPLACEMENT" ? `${item.quantity} unit` : `${item.quantity} × ${formatRupiah(item.unitPriceSnapshot)}`}
												</p>
											</div>
											{selectedRow.kind === "REPLACEMENT" ? null : (
												<p className="shrink-0 font-semibold text-slate-900">
													{formatRupiah(item.subtotal ?? item.quantity * item.unitPriceSnapshot)}
												</p>
											)}
										</li>
									))}
									{selectedRow.kind === "REPLACEMENT" ? null : (
										<li className="flex justify-between gap-3 bg-slate-50 px-4 py-3 font-semibold">
											<span className="text-slate-700">Total Pesanan</span>
											<span className="text-slate-900">{formatRupiah(selectedRow.totalAmount)}</span>
										</li>
									)}
								</ul>
							)}
						</section>
						<div className="rounded-xl border border-slate-200 p-4">
							<p className="type-label text-slate-500">Catatan</p>
							<p className="mt-2 text-slate-700">{selectedRow.note}</p>
						</div>
						{selectedRow.canConfirmReceipt && selectedRow.deliveryOrderId ? (
							<div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
								<p className="font-semibold">Barang sudah dikirim oleh gudang.</p>
								<p className="mt-1 text-sm">
									Konfirmasi hanya jika barang untuk pesanan ini sudah diterima toko.
								</p>
							</div>
						) : selectedRow.statusKey !== "RECEIVED" && selectedRow.statusKey !== "CANCELLED" ? (
							<div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-600">
								Konfirmasi penerimaan tersedia setelah gudang mengirim barang.
							</div>
						) : null}
						<div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
							<Button variant="secondary" onClick={() => setSelectedRow(null)}>
								Tutup
							</Button>
							{selectedRow.canConfirmReceipt && selectedRow.deliveryOrderId ? (
								<Button onClick={() => void handleConfirmReceipt(selectedRow)}>
									Konfirmasi Barang Diterima
								</Button>
							) : null}
						</div>
					</div>
				) : null}
			</Modal>

		</TokoFeatureLayout>
	);
}

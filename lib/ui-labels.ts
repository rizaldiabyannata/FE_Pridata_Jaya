export const invoiceStatusLabel: Record<string, string> = {
	UNPAID: "Belum Lunas",
	PARTIAL: "Bayar Sebagian",
	PAID: "Lunas",
	CANCELLED: "Dibatalkan",
};

export const invoiceDraftStatusLabel: Record<string, string> = {
	DRAFT: "Rancangan",
	FINALIZED: "Difinalisasi",
	CANCELLED: "Dibatalkan",
};

/** Tahap retur menurut status backend: membedakan "menunggu akuntan" dari "selesai". */
export const returnLifecycleLabel: Record<string, string> = {
	REQUESTED: "Menunggu Pemeriksaan Gudang",
	RECEIVED_BY_WAREHOUSE: "Diterima Gudang",
	ACCOUNTING_REVIEW: "Menunggu Keputusan Akuntan",
	CREDITED: "Selesai - Saldo Toko",
	REPLACEMENT_PENDING: "Menunggu DO Pengganti",
	REPLACED: "Selesai - Barang Pengganti",
	RETURNED: "Selesai - Retur Barang",
	REJECTED: "Ditolak",
	CANCELLED: "Dibatalkan",
};

export const deliveryOrderStatusLabel: Record<string, string> = {
	OPEN: "Baru Dibuat",
	PICKING: "Sedang Pengambilan",
	PACKING: "Sedang Pengemasan",
	READY_TO_SHIP: "Siap Dikirim",
	PARTIALLY_SHIPPED: "Terkirim Sebagian",
	SHIPPED: "Terkirim",
	RECEIVED: "Diterima",
	CANCELLED: "Dibatalkan",
};

export const paymentStatusLabel: Record<string, string> = {
	PENDING: "Menunggu",
	VERIFIED: "Terverifikasi",
	CANCELLED: "Dibatalkan",
};

export const paymentMethodLabel: Record<string, string> = {
	CASH: "Tunai",
	TRANSFER: "Transfer",
};

export const orderStatusLabel: Record<string, string> = {
	PENDING: "Menunggu",
	PROCESSED: "Diproses",
	CANCELLED: "Dibatalkan",
};

export const transferStatusLabel: Record<string, string> = {
	PENDING: "Menunggu",
	IN_TRANSIT: "Dalam Perjalanan",
	COMPLETED: "Selesai",
	CANCELLED: "Dibatalkan",
};

export const reconciliationStatusLabel: Record<string, string> = {
	DRAFT: "Rancangan",
	CONFIRMED: "Terkonfirmasi",
	CANCELLED: "Dibatalkan",
};

export const verificationStatusLabel: Record<string, string> = {
	PENDING: "Menunggu Verifikasi",
	VERIFIED: "Terverifikasi",
	REJECTED: "Ditolak",
};

export function toUiLabel(value: string | null | undefined, labels: Record<string, string>): string {
	if (!value) return "-";
	return labels[value] ?? value;
}

export type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger";

/**
 * Satu sumber warna status untuk seluruh aplikasi.
 * Sebelumnya tiap halaman mendefinisikan map `statusColors`-nya sendiri
 * dengan palet amber/emerald/rose yang saling tumpang tindih.
 */
const STATUS_TONES: Record<string, StatusTone> = {
	// Pembayaran & invoice
	PAID: "success",
	VERIFIED: "success",
	RECEIVED: "success",
	CONFIRMED: "success",
	COMPLETED: "success",
	APPROVED: "success",
	ACTIVE: "success",
	PARTIAL: "warning",
	PENDING: "warning",
	PROCESSED: "brand",
	OPEN: "brand",
	DRAFT: "neutral",
	FINALIZED: "brand",
	UNPAID: "danger",
	OVERDUE: "danger",
	REJECTED: "danger",
	CANCELLED: "neutral",
	INACTIVE: "neutral",
	// Alur gudang
	PICKING: "brand",
	PACKING: "brand",
	READY_TO_SHIP: "brand",
	SHIPPED: "brand",
};

export function statusTone(value: string | null | undefined): StatusTone {
	if (!value) return "neutral";
	return STATUS_TONES[value.toUpperCase().replace(/[\s-]+/g, "_")] ?? "neutral";
}

/** `daysOverdue` dari BE: hari lewat jatuh tempo, 0 = belum jatuh tempo. */
export const daysOverdueLabel = (days: number) => (days > 0 ? `${days} hari` : "Belum jatuh tempo");

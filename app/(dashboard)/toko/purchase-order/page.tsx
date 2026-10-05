"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ShoppingBag, Trash2 } from "lucide-react";
import Badge from "@/components/shared/Badge";
import Button from "@/components/shared/Button";
import { fieldClasses } from "@/components/shared/FormInput";
import Card from "@/components/shared/Card";
import ConfirmDialog from "@/components/shared/ConfirmDialog";
import PageFeedback from "@/components/shared/PageFeedback";
import QuantityStepper from "@/components/shared/QuantityStepper";
import ResponsiveTable, { type ResponsiveColumn } from "@/components/shared/ResponsiveTable";
import TokoStorefrontShell from "@/components/toko/TokoStorefrontShell";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";
import { formatRupiah } from "@/lib/format";
import { statusTone, toUiLabel, verificationStatusLabel } from "@/lib/ui-labels";
import { ordersService, type CreateOrderPayload } from "@/services/orders";
import { tokoService } from "@/services/toko";
import { storeCreditsService, type StoreCreditBalance } from "@/services/store-credits";
import {
	clearTokoCart,
	readTokoCart,
	setActiveTokoCartStore,
	type TokoCartItem,
	writeTokoCart,
	normalizeSellableCartCondition,
} from "@/services/toko-cart";

interface ErrorWithMessage {
	response?: {
		data?: {
			message?: string;
		};
	};
}

const getErrorMessage = (error: unknown, fallback: string) =>
	(error as ErrorWithMessage)?.response?.data?.message || fallback;

export default function StorePurchaseOrderPage() {
	const checkoutKey = useIdempotencyKey();
	const [storeId, setStoreId] = useState("");
	const [storeName, setStoreName] = useState("Toko");
	const [storeVerificationStatus, setStoreVerificationStatus] = useState("");
	const [cart, setCart] = useState<TokoCartItem[]>([]);
	const [notes, setNotes] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	const [cartHydrated, setCartHydrated] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [submittedOrder, setSubmittedOrder] = useState<{
		orderNumber: string;
		itemCount: number;
		total: number;
		creditUsed: number;
	} | null>(null);
	const [useStoreCredit, setUseStoreCredit] = useState(false);
	const [creditBalance, setCreditBalance] = useState<StoreCreditBalance | null>(null);

	useEffect(() => {
		const syncCart = () => {
			setCart(readTokoCart());
			setCartHydrated(true);
		};

		const load = async () => {
			try {
				const dashboard = await tokoService.getDashboard().catch(() => null);
				if (dashboard?.store?.storeId) {
					setStoreId(dashboard.store.storeId);
					setActiveTokoCartStore(dashboard.store.storeId);
					setCart(readTokoCart());
					setStoreName(dashboard.store.storeName || "Toko");
					setStoreVerificationStatus(dashboard.store.verificationStatus || "");
					void storeCreditsService
						.getTokoBalance(dashboard.store.storeId)
						.then(setCreditBalance)
						.catch(() => setCreditBalance(null));
				}
			} catch (err: unknown) {
				setError(getErrorMessage(err, "Gagal memuat data checkout."));
			}
		};

		syncCart();
		void load();
		window.addEventListener("toko-cart-updated", syncCart);
		return () => {
			window.removeEventListener("toko-cart-updated", syncCart);
		};
	}, []);

	const persistCart = (items: TokoCartItem[]) => {
		setCart(items);
		writeTokoCart(items);
	};

	const removeFromCart = (productId: string, condition: string) => {
		persistCart(
			cart.filter((item) => !(item.productId === productId && item.condition === condition)),
		);
	};

	const updateQty = (productId: string, condition: string, qty: number) => {
		persistCart(
			cart.map((item) =>
				item.productId === productId && item.condition === condition
					? { ...item, quantity: Math.max(1, Math.floor(qty || 1)) }
					: item,
			),
		);
	};

	const subtotal = useMemo(
		() => cart.reduce((sum, item) => sum + item.quantity * item.unitPriceSnapshot, 0),
		[cart],
	);
	const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
	const hasInvalidPrice = cart.some((item) => item.unitPriceSnapshot <= 0);
	const availableCredit = Math.max(0, creditBalance?.availableBalance ?? creditBalance?.balance ?? 0);
	const creditUsed = useStoreCredit ? Math.min(subtotal, availableCredit) : 0;
	const remainingAfterCredit = Math.max(0, subtotal - creditUsed);

	const handleCheckout = async () => {
		if (!storeId) {
			setError("Data toko tidak ditemukan. Pastikan akun toko sudah login.");
			return;
		}
		if (cart.length === 0) {
			setError("Keranjang kosong.");
			return;
		}
		if (hasInvalidPrice) {
			setError("Ada produk tanpa harga jual. Lengkapi harga katalog terlebih dahulu sebelum checkout.");
			return;
		}

		setSubmitting(true);
		setError("");
		setSuccess("");
		try {
			// The server remains authoritative, but refresh the displayed balance at
			// the last possible moment after a newly approved return. Display only:
			// a failed refresh must not stop the order.
			const freshBalance = useStoreCredit
				? await storeCreditsService.getTokoBalance(storeId).catch(() => null)
				: null;
			if (freshBalance) setCreditBalance(freshBalance);
			const freshAvailableCredit = Math.max(0, freshBalance?.availableBalance ?? freshBalance?.balance ?? availableCredit);
			const freshCreditUsed = useStoreCredit ? Math.min(subtotal, freshAvailableCredit) : 0;
			const payload: CreateOrderPayload = {
				storeId,
				notes: notes.trim() || undefined,
				items: cart.map((item) => ({
					productId: item.productId,
					condition: normalizeSellableCartCondition(item).condition,
					quantity: item.quantity,
					unitPriceSnapshot: item.unitPriceSnapshot,
				})),
				useStoreCredit,
			};
			const order = await ordersService.createForToko(payload, checkoutKey.key);
			checkoutKey.reset();
			/*
			 * Dulu: toast, tunggu 1200ms, lalu lempar ke riwayat-transaksi yang
			 * tidak menyorot order baru — nomor pesanannya tidak pernah ikut.
			 * "Pesanan saya masuk tidak?" adalah momen terpenting di alur ini,
			 * jadi jawabannya tinggal di halaman sampai toko yang menutupnya.
			 */
			setSubmittedOrder({ orderNumber: order.orderNumber, itemCount: cart.length, total: subtotal, creditUsed: freshCreditUsed });
			clearTokoCart();
			setCart([]);
			setNotes("");
			setUseStoreCredit(false);
		} catch (err: unknown) {
			setError(getErrorMessage(err, "Gagal membuat order."));
		} finally {
			setSubmitting(false);
		}
	};

	const columns: ResponsiveColumn<TokoCartItem>[] = [
		{
			key: "productName",
			head: "Produk",
			role: "title",
			render: (item) => (
				<div className="flex items-center gap-3">
					<span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-slate-100">
						{item.imageUrl ? (
							<Image
								src={item.imageUrl}
								alt=""
								width={44}
								height={44}
								unoptimized
								className="h-full w-full object-cover"
							/>
						) : null}
					</span>
					<span className="min-w-0 font-medium text-slate-900">{item.productName}</span>
				</div>
			),
		},
		{
			key: "subtotal",
			head: "Subtotal",
			role: "amount",
			align: "right",
			render: (item) => formatRupiah(item.quantity * item.unitPriceSnapshot),
		},
		{
			key: "condition",
			head: "Kondisi",
			render: (item) => <span className="text-slate-700">{item.condition}</span>,
		},
		{
			key: "unitPriceSnapshot",
			head: "Harga",
			align: "right",
			render: (item) =>
				item.unitPriceSnapshot > 0 ? (
					formatRupiah(item.unitPriceSnapshot)
				) : (
					<Badge tone="danger">Belum ada harga</Badge>
				),
		},
		{
			key: "quantity",
			head: "Jumlah",
			render: (item) => (
				<QuantityStepper
					value={item.quantity}
					onChange={(next) => updateQty(item.productId, item.condition, next)}
				/>
			),
		},
		{
			key: "remove",
			head: "Aksi",
			role: "action",
			align: "right",
			render: (item) => (
				<Button
					variant="danger"
					size="sm"
					onClick={() => removeFromCart(item.productId, item.condition)}
				>
					<Trash2 className="h-4 w-4" />
					Hapus
				</Button>
			),
		},
	];

	if (submittedOrder) {
		return (
			<TokoStorefrontShell title="Pesanan Terkirim" cartCount={cartCount}>
				<Card className="border-brand-100 bg-brand-50">
					<p className="type-label text-brand-800">Pesanan terkirim</p>
					<p className="type-display mt-2 text-slate-900">{submittedOrder.orderNumber}</p>
					<p className="mt-2 text-sm text-slate-700">
						{submittedOrder.itemCount} item · {formatRupiah(submittedOrder.total)}. Pridata akan
						memproses pesanan ini jadi faktur. Simpan nomor di atas untuk menanyakannya.
						{submittedOrder.creditUsed
							? ` Kredit toko ${formatRupiah(submittedOrder.creditUsed)} ditahan sampai invoice diterbitkan.`
							: null}
					</p>
					<div className="mt-4 flex flex-wrap gap-2">
						<Button href="/toko/riwayat-transaksi" variant="primary">
							Lihat status pesanan
						</Button>
						<Button href="/toko/katalog" variant="secondary">
							Belanja lagi
						</Button>
					</div>
				</Card>
			</TokoStorefrontShell>
		);
	}

	return (
		<TokoStorefrontShell title="Keranjang" cartCount={cartCount}>
			<PageFeedback
				error={error}
				success={success}
				onDismissError={() => setError("")}
				onDismissSuccess={() => setSuccess("")}
			/>

			<Card className="border-brand-100 bg-brand-50">
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div className="min-w-0">
						<p className="type-body font-semibold text-slate-900">{storeName}</p>
						<p className="text-xs text-slate-600">
							Periksa jumlah dan harga, lalu kirim. Pesanan diproses jadi faktur oleh Pridata.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{storeVerificationStatus ? (
							<Badge tone={statusTone(storeVerificationStatus)}>
								Status toko: {toUiLabel(storeVerificationStatus, verificationStatusLabel)}
							</Badge>
						) : null}
						<Button href="/toko/katalog" variant="secondary" size="sm">
							<ShoppingBag className="h-4 w-4" />
							Tambah Produk
						</Button>
					</div>
				</div>
			</Card>

			<section className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h2 className="type-title text-slate-900">
						Rincian Pesanan{cart.length ? ` (${cart.length} item)` : ""}
					</h2>
					{cart.length > 0 ? (
						<Button variant="danger" size="sm" onClick={() => setConfirmClear(true)}>
							Kosongkan
						</Button>
					) : null}
				</div>

				<ResponsiveTable
					columns={columns}
					data={cart}
					getRowKey={(item) => `${item.productId}-${item.condition}`}
					loading={!cartHydrated}
					skeletonRows={2}
					emptyText="Keranjang masih kosong"
					emptyDescription="Pilih produk dari katalog terlebih dahulu, lalu kembali ke sini untuk mengajukan pesanan."
					emptyAction={
						<Button href="/toko/katalog" variant="commerce">
							Buka Katalog
						</Button>
					}
					summary={
						cart.length > 0 ? (
							<div className="hidden items-center justify-between gap-4 px-4 py-3 md:flex">
								<span className="type-body font-medium text-slate-600">Total</span>
								<span className="text-lg font-bold text-slate-900">{formatRupiah(subtotal)}</span>
							</div>
						) : null
					}
				/>
			</section>

			{cart.length > 0 ? (
				<Card>
					<h2 className="type-title text-slate-900">Checkout</h2>
					<label className="mt-4 block space-y-1.5">
						<span className="block text-sm font-medium text-slate-700">
							Catatan <span className="font-normal text-slate-400">(opsional)</span>
						</span>
						<input
							className={fieldClasses("control", "md:max-w-md")}
							placeholder="mis. minta kirim pagi"
							value={notes}
							onChange={(event) => setNotes(event.target.value)}
							disabled={submitting}
						/>
					</label>
					<label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm text-slate-700">
						<input
							type="checkbox"
							checked={useStoreCredit}
							onChange={(event) => setUseStoreCredit(event.target.checked)}
							disabled={submitting || availableCredit <= 0}
							className="mt-0.5 h-5 w-5 accent-brand-700"
						/>
						<span>
							<span className="block font-semibold text-slate-900">Gunakan Kredit Toko</span>
							<span className="mt-0.5 block text-xs text-slate-600">
								Saldo tersedia: {formatRupiah(availableCredit)}. Kredit dipakai otomatis sampai nilai
								pesanan terpenuhi.
							</span>
						</span>
					</label>
					{useStoreCredit ? (
						<div className="mt-3 flex flex-wrap justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
							<span>
								Kredit yang digunakan: <strong>{formatRupiah(creditUsed)}</strong>
							</span>
							<span>
								Sisa tagihan invoice: <strong>{formatRupiah(remainingAfterCredit)}</strong>
							</span>
						</div>
					) : null}
					{hasInvalidPrice ? (
						<p className="type-body mt-3 text-rose-700">
							Ada produk tanpa harga jual. Hapus produk tersebut atau hubungi sales sebelum
							mengajukan pesanan.
						</p>
					) : null}

					{/* Total + CTA hanya di desktop; di HP dipegang bilah lengket di bawah. */}
					<div className="mt-4 hidden items-center justify-between gap-3 md:flex">
						<div className="type-body text-slate-600">
							Total:{" "}
							<span className="font-semibold text-slate-900">{formatRupiah(subtotal)}</span>
						</div>
						<Button
							variant="commerce"
							onClick={handleCheckout}
							disabled={submitting || hasInvalidPrice || !storeId}
						>
							{submitting ? "Mengirim..." : "Kirim Pesanan"}
						</Button>
					</div>
				</Card>
			) : null}

			{cart.length > 0 ? <div aria-hidden className="h-16 md:hidden" /> : null}

			{/*
			 * Bilah checkout lengket di atas bottom tab bar. Sebelumnya CTA ada di
			 * dasar halaman yang menggulir — di HP pengguna harus melewati seluruh
			 * tabel keranjang untuk menemukannya.
			 */}
			{cart.length > 0 ? (
				<div className="fixed inset-x-0 bottom-tabbar-gap z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:hidden">
					<div className="flex items-center gap-3">
						<div className="min-w-0 flex-1">
							<p className="type-label text-slate-500">
								Total
							</p>
							<p className="truncate text-base font-bold text-slate-900">
								{formatRupiah(subtotal)}
							</p>
						</div>
						<Button
							variant="commerce"
							onClick={handleCheckout}
							disabled={submitting || hasInvalidPrice || !storeId}
						>
							{submitting ? "Mengirim..." : "Kirim Pesanan"}
						</Button>
					</div>
				</div>
			) : null}

			<ConfirmDialog
				isOpen={confirmClear}
				title="Kosongkan keranjang?"
				description={`${cart.length} item akan dihapus dari keranjang. Tindakan ini tidak bisa dibatalkan.`}
				confirmLabel="Ya, kosongkan"
				onConfirm={() => {
					clearTokoCart();
					setCart([]);
				}}
				onClose={() => setConfirmClear(false)}
			/>
		</TokoStorefrontShell>
	);
}

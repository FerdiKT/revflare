package app.revflare.kit

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

/**
 * RevflareKit for Android: install attribution (Play Install Referrer), purchase links, offerings, events, remote
 * config and (optionally) Google Play Billing purchases for a self-hosted Revflare server.
 *
 * Call [configure] once at launch (`Application.onCreate`). RevflareKit then, in the background:
 * - reads the Play Install Referrer once and sends it to `POST /sdk/v1/report` with a random install id, so Revflare
 *   can tell Google Ads, referral links and organic installs apart;
 * - reports the order ids and purchase tokens of the Play purchases this install owns, so their revenue joins the
 *   install's source (needed for apps that buy through RevenueCat or their own billing code);
 * - collects app-usage events for funnels ([track], automatic `first_open` / `app_open` / `session_start` /
 *   `app_background`), off with [analyticsEnabled];
 * - fetches the remote config ([remoteConfig]).
 *
 * Attribution never acknowledges, consumes or buys anything: it only reads Play Billing. Safe next to RevenueCat.
 * Apps without RevenueCat can buy and check entitlements with [RevflareStore] ([configurePurchases]).
 *
 * Threading: [configure] reads RevflareKit's own small SharedPreferences file and the install-id file in
 * `noBackupFilesDir` on the calling thread (once per process, a few KB), so that [installId], the cached
 * [remoteConfig] values and [attribution] are ready when it returns, and a backup restored from another device is
 * detected before anything uses it. Everything else (network, Play Billing, Install Referrer, the event queue on disk)
 * runs in the background. Under StrictMode's disk-read policy, wrap the call in `StrictMode.allowThreadDiskReads()`.
 */
public object Revflare {
    /** The library version (sent in the `User-Agent` and config requests). */
    public const val VERSION: String = "1.9.1"

    private class Runtime(
        val context: Context,
        val store: KeyValueStore,
        val identity: InstallIdentity,
        val client: RevflareClient,
        val reporter: Reporter,
        val billing: BillingBackend,
        val offerings: OfferingsService<ResolvedProduct>,
        val events: EventTracker,
        val scope: CoroutineScope,
        val debuggable: Boolean,
    )

    @Volatile
    private var runtime: Runtime? = null
    private val lock = Any()
    @Volatile
    private var environmentOverride = RevflareEnvironment.AUTOMATIC
    private val _attribution = MutableStateFlow(RevflareAttribution.UNKNOWN)
    @Volatile
    private var analyticsFlag: Boolean? = null
    internal val eventPipe = EventPipe()

    /** Prints what RevflareKit does to Logcat (tag `RevflareKit`). Off by default. */
    @JvmStatic
    public var debugLogging: Boolean
        get() = Log.enabled
        set(value) {
            Log.enabled = value
        }

    /** True once [configure] ran. */
    @JvmStatic
    public val isConfigured: Boolean get() = runtime != null

    /**
     * Starts RevflareKit. Call once at launch, from `Application.onCreate`. Returns after reading RevflareKit's small
     * preferences and install-id file (see the class documentation); network and Play Billing work happens in the
     * background. Later calls are ignored.
     *
     * @param sdkKey The app's SDK key (`rfp_...`), shown in Revflare under Apps → the app. It identifies the app and is
     *   not a secret.
     * @param server Your Revflare server, e.g. `https://revflare.example.com` (the address of the web app).
     * @param environment [RevflareEnvironment.AUTOMATIC] (default): a debuggable build reports `debug`, others
     *   `production`. Pass [RevflareEnvironment.SANDBOX] for internal test builds.
     */
    @JvmStatic
    @JvmOverloads
    @OptIn(ExperimentalCoroutinesApi::class)
    public fun configure(
        context: Context,
        sdkKey: String,
        server: String,
        environment: RevflareEnvironment = RevflareEnvironment.AUTOMATIC,
    ) {
        val key = sdkKey.trim()
        if (key.isEmpty()) {
            Log.error("Revflare.configure: the SDK key is empty; RevflareKit stays off")
            return
        }
        val app = context.applicationContext ?: context
        val created = synchronized(lock) {
            if (runtime != null) {
                Log.debug { "Revflare.configure called again: ignored" }
                return
            }
            environmentOverride = environment
            val debuggable = EnvironmentDetector.isDebuggable(app)
            val store = SharedPreferencesStore(app.getSharedPreferences("app.revflare.kit", Context.MODE_PRIVATE))
            val identity = InstallIdentity(store, FileNoBackupMarker(File(app.noBackupFilesDir, "app.revflare.kit/install-id")))
            // First: a backup restored onto another device is detected here and cleared before anything reads it.
            identity.resolve()
            analyticsFlag?.let { store.set(EventTracker.ENABLED_KEY, if (it) "1" else "0") }

            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val client = RevflareClient(server, key, UrlConnectionTransport(), environment = { Revflare.environment.wireValue })
            val appInfo = AndroidAppInfo(app)
            val billing = PlayBillingBackend(app)
            val existingInstall = store.string(Reporter.STATE_KEY) != null
            val gate = AttributionGate(open = existingInstall)

            val reporter = Reporter(
                client,
                ReporterEnvironment(
                    referrer = PlayInstallReferrerSource(app),
                    purchases = billing,
                    store = store,
                    identity = identity,
                    appVersion = appInfo.appVersion.ifEmpty { null },
                    deviceIdentifiers = AndroidDeviceIdentifierProvider(app, appInfo),
                    clock = systemClock,
                    serial = Dispatchers.IO.limitedParallelism(1),
                    scope = scope,
                    onAttributionChange = { attributionDidChange(it) },
                    onFirstReport = { gate.open() },
                ),
            )
            _attribution.value = reporter.attribution

            val catalog = object : ProductCatalog<ResolvedProduct> {
                override suspend fun products(specs: Set<String>): Map<String, ResolvedProduct> {
                    val details = billing.queryProductDetails(specs.map(::productIdOf).toSet())
                        ?: throw IllegalStateException("Google Play Billing is not available")
                    val byId = details.associateBy { it.productId }
                    return specs.mapNotNull { spec -> byId[productIdOf(spec)]?.let { ResolvedProduct.resolve(spec, it) }?.let { spec to it } }.toMap()
                }
            }
            val offerings = OfferingsService(OfferingsFetcher(client, store, appInfo.appVersion.ifEmpty { null }, systemClock), catalog)

            val events = EventTracker(
                client,
                EventsEnvironment(
                    storage = FileEventStorage(File(app.noBackupFilesDir, "app.revflare.kit/events.jsonl")),
                    store = store,
                    identity = identity,
                    context = { appInfo.appContext() },
                    clock = systemClock,
                    serial = Dispatchers.IO.limitedParallelism(1),
                    scope = scope,
                ),
            )
            scope.launch { for (command in eventPipe.channel) events.handle(command) }
            // After the events tracked before configure (already in the pipe).
            eventPipe.send(EventCommand.Launch(System.currentTimeMillis(), existingInstall))

            val fetcher = RemoteConfigFetcher(
                client,
                SystemRemoteConfigContextProvider(
                    identity = identity,
                    appContext = { appInfo.appContext() },
                    gate = gate,
                    storefront = { billing.billingCountry() },
                    attribution = { Revflare.attribution },
                    environment = { Revflare.environment.wireValue },
                ),
                systemClock,
            )
            remoteConfig.attach(store)
            RemoteConfigStorage(store).rememberScope(fetcher.cacheKey)

            val created = Runtime(app, store, identity, client, reporter, billing, offerings, events, scope, debuggable)
            runtime = created
            remoteConfig.start(fetcher, scope)
            scope.launch { reporter.sync(SyncTrigger.LAUNCH) }
            scope.launch { billing.updates.collect { reporter.sync(SyncTrigger.PURCHASE_UPDATE) } }
            Log.debug { "Configured for ${client.server}" }
            created
        }
        observeLifecycle(created)
        // An opt-in made before configure.
        applyMetaOptIn()
    }

    private fun observeLifecycle(runtime: Runtime) {
        Handler(Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                private var started = false

                override fun onStart(owner: LifecycleOwner) {
                    // The first start is the launch itself (configure already did that work).
                    if (!started) {
                        started = true
                        return
                    }
                    val now = System.currentTimeMillis()
                    runtime.scope.launch { runtime.reporter.sync(SyncTrigger.FOREGROUND) }
                    eventPipe.send(EventCommand.Foreground(now))
                    runtime.scope.launch { remoteConfig.foregroundRefresh() }
                    store?.foreground()
                }

                override fun onStop(owner: LifecycleOwner) {
                    started = true
                    eventPipe.send(EventCommand.Background(System.currentTimeMillis()))
                }
            })
        }
    }

    // Attribution and environment

    /**
     * How this install was acquired (Google Ads, referral, organic), as Revflare resolved it from the Play Install
     * Referrer. [RevflareAttribution.UNKNOWN] until then. Kept on the device.
     */
    @JvmStatic
    public val attribution: RevflareAttribution get() = _attribution.value

    /** [attribution] as a flow. */
    @JvmStatic
    public val attributionFlow: StateFlow<RevflareAttribution> = _attribution.asStateFlow()

    private fun attributionDidChange(value: RevflareAttribution) {
        _attribution.value = value
        runtime?.scope?.launch { remoteConfig.attributionChanged(value) }
    }

    /**
     * The environment RevflareKit reports for this run (never [RevflareEnvironment.AUTOMATIC]): the one passed to
     * [configure], else detected (debuggable build → `debug`, else `production`).
     */
    @JvmStatic
    public val environment: RevflareEnvironment
        get() = EnvironmentDetector.resolve(environmentOverride, runtime?.debuggable ?: false)

    /** The app's remote config (parameters set in Revflare web → the app → Remote config). */
    @JvmStatic
    public val remoteConfig: RevflareRemoteConfig = RevflareRemoteConfig()

    /**
     * This install's id: a random UUID (lowercase) created on first launch, kept in RevflareKit's SharedPreferences
     * and never restored onto another device. Carries no personal data. A reinstall gets a new one.
     *
     * @throws IllegalStateException before [configure] (use [installId] with a context then).
     */
    @JvmStatic
    public val installId: String
        get() = runtime?.identity?.resolve() ?: throw IllegalStateException("Call Revflare.configure first, or Revflare.installId(context)")

    /** This install's id, also before [configure]. */
    @JvmStatic
    public fun installId(context: Context): String {
        runtime?.let { return it.identity.resolve() }
        val app = context.applicationContext ?: context
        val store = SharedPreferencesStore(app.getSharedPreferences("app.revflare.kit", Context.MODE_PRIVATE))
        return InstallIdentity(store, FileNoBackupMarker(File(app.noBackupFilesDir, "app.revflare.kit/install-id"))).resolve()
    }

    // Purchases

    /** The store created by [configurePurchases], null before. */
    @JvmStatic
    @Volatile
    public var store: RevflareStore? = null
        private set

    /**
     * Creates the app's [RevflareStore] (Google Play Billing purchases and entitlements) and keeps it in [store]. Call
     * once at launch, after [configure]; later calls return the first store.
     *
     * The store acknowledges and consumes the app's purchases: do not use it together with RevenueCat.
     *
     * @param entitlements Entitlement name → Play product ids that grant it, e.g. `mapOf("pro" to listOf("pro_sub", "pro_lifetime"))`.
     *   The entitlements set in Revflare are added to it (union per entitlement).
     * @param productIds Products to load besides the offerings' (and the entitlements').
     * @param consumables Product ids consumed after purchase (coins, credits); they never grant entitlements.
     * @param useOfferings Load the offerings set in Revflare at start and on foreground, and add their products. With
     *   false the store still reads the entitlements and pass durations set in Revflare: one request to the Revflare
     *   server at start and on foreground (cached 5 minutes, then a 304 when unchanged), and no offerings.
     * @param onConsumablePurchased Grants consumables bought outside a purchase flow (a pending purchase completed
     *   later, also while the app was closed); see [RevflareStore.onConsumablePurchased]. Set here so the purchases
     *   found at launch are granted at once.
     */
    @JvmStatic
    @JvmOverloads
    public fun configurePurchases(
        entitlements: Map<String, List<String>>,
        productIds: List<String> = emptyList(),
        consumables: Set<String> = emptySet(),
        useOfferings: Boolean = true,
        onConsumablePurchased: (suspend (RevflarePurchase) -> Unit)? = null,
    ): RevflareStore = configurePurchases(entitlements, productIds, consumables, useOfferings, emptyMap(), onConsumablePurchased)

    /**
     * [configurePurchases] with non-renewing passes: one-time Play products that grant their entitlements for a
     * duration, e.g. `nonRenewingDurations = mapOf("pass_3day" to NonRenewingDuration.days(3))`. Durations set in
     * Revflare apply only to products the app does not declare here (entitlements, productIds, consumables): declared
     * products use these local durations only. A product with a local duration is a pass, never a consumable. See
     * [RevflareStore] for how passes are acknowledged, consumed (only right before the same pass is bought again) and
     * stacked.
     */
    @JvmStatic
    @JvmOverloads
    public fun configurePurchases(
        entitlements: Map<String, List<String>>,
        productIds: List<String> = emptyList(),
        consumables: Set<String> = emptySet(),
        useOfferings: Boolean = true,
        nonRenewingDurations: Map<String, NonRenewingDuration>,
        onConsumablePurchased: (suspend (RevflarePurchase) -> Unit)? = null,
    ): RevflareStore {
        synchronized(lock) {
            store?.let { return it }
            val runtime = runtime ?: throw IllegalStateException("Call Revflare.configure before Revflare.configurePurchases")
            val mapping = EntitlementMapping.of(entitlements)
            val created = RevflareStore(
                productIds = RevflareStore.merge(
                    productIds,
                    mapping.allProductIds.sorted() + nonRenewingDurations.keys.sorted() + consumables.sorted(),
                ),
                mapping = mapping,
                consumables = consumables,
                backend = runtime.billing,
                scope = runtime.scope,
                accountId = { runtime.identity.resolve() },
                linkPurchases = { syncPurchases() },
                trackEvent = { name, props -> trackAutomatic(name, props) },
                offeringsLoader = { policy -> offerings(policy) },
                loadsOfferingsAutomatically = useOfferings,
                nonRenewingDurations = nonRenewingDurations,
                storage = runtime.store,
            )
            created.onConsumablePurchased = onConsumablePurchased
            store = created
            created.start()
            return created
        }
    }

    /**
     * The app's offerings, as set in Revflare (web → the app → Offerings). Works with or without [RevflareStore]. The
     * last good answer is kept on the device; any network failure falls back to it. Packages whose Play product can't
     * be loaded are left out.
     *
     * @throws RevflareOfferingsException
     */
    @JvmStatic
    public suspend fun offerings(fetchPolicy: OfferingsFetchPolicy = OfferingsFetchPolicy.CACHED_OR_FETCHED): RevflareOfferings {
        val service = runtime?.offerings ?: throw RevflareOfferingsException.NotConfigured()
        return RevflareOfferings(service.offerings(fetchPolicy))
    }

    /**
     * Reports new purchases right away instead of at the next launch or foreground. Optional: call it after a purchase
     * made through another SDK (e.g. RevenueCat). Does nothing before [configure].
     */
    @JvmStatic
    public fun syncPurchases() {
        val runtime = runtime ?: return
        runtime.scope.launch { runtime.reporter.sync(SyncTrigger.MANUAL) }
    }

    // Meta

    /**
     * Opts in to Meta (Facebook) ads matching and sets the Facebook SDK's anonymous id:
     * `Revflare.setMetaAnonymousID(AppEventsLogger.getAnonymousAppDeviceGUID(context))`. RevflareKit does not depend on
     * the Facebook SDK. Call it only after the app's own consent flow; nothing is collected before this or
     * [collectDeviceIdentifiers]. Can be called before or after [configure] (stored once configure ran).
     */
    @JvmStatic
    public fun setMetaAnonymousID(id: String) {
        val value = id.trim()
        if (value.isEmpty()) {
            Log.debug { "Revflare.setMetaAnonymousID: empty id ignored" }
            return
        }
        pendingMetaOptIn = value
        applyMetaOptIn()
    }

    /**
     * Opts in to device identifiers for Meta (Facebook) ads matching without a Facebook anonymous id (Google
     * advertising id when available and ad tracking is not limited, device info), and re-checks them now. Calling it
     * again is cheap: nothing is sent when nothing changed.
     */
    @JvmStatic
    public fun collectDeviceIdentifiers() {
        if (pendingMetaOptIn == null) pendingMetaOptIn = ""
        applyMetaOptIn()
    }

    @Volatile
    private var pendingMetaOptIn: String? = null

    private fun applyMetaOptIn() {
        val runtime = runtime ?: return
        val pending = pendingMetaOptIn ?: return
        pendingMetaOptIn = null
        Reporter.optIn(runtime.store, pending.ifEmpty { null })
        runtime.scope.launch { runtime.reporter.sync(SyncTrigger.IDENTIFIERS) }
    }

    // Events

    /**
     * Records an app-usage event for funnels: `Revflare.track("onboarding_step", mapOf("step" to 2))`.
     *
     * Thread-safe; returns at once (queued on disk, sent in batches). Events tracked before [configure] wait in memory.
     * Nothing is recorded while [analyticsEnabled] is false.
     *
     * @param name 1-64 characters of `A-Z a-z 0-9 _ . : -`. Other names are dropped.
     * @param properties Up to 10 values; keys 1-40 characters of `A-Z a-z 0-9 _ . -`. Strings (cut to 100
     *   characters), numbers, booleans, UUIDs, dates and enums; other values are dropped. Never personal data.
     */
    @JvmStatic
    @JvmOverloads
    public fun track(name: String, properties: Map<String, Any?> = emptyMap()) {
        if (!analyticsEnabled) return
        val event = EventSanitizer.event(name, properties, System.currentTimeMillis()) ?: return
        eventPipe.send(EventCommand.Track(event))
    }

    /** Records that a paywall is shown (`paywall_view`, with `placement` and `offering`). */
    @JvmStatic
    @JvmOverloads
    public fun trackPaywallView(placement: String? = null, offering: RevflareOffering? = null) {
        track("paywall_view", paywallProperties(placement, offering?.identifier))
    }

    /** Records that a paywall was closed without buying (`paywall_close`, with `placement` and `offering`). */
    @JvmStatic
    @JvmOverloads
    public fun trackPaywallClose(placement: String? = null, offering: RevflareOffering? = null) {
        track("paywall_close", paywallProperties(placement, offering?.identifier))
    }

    internal fun paywallProperties(placement: String?, offeringId: String?): Map<String, Any?> {
        val properties = LinkedHashMap<String, Any?>()
        if (!placement.isNullOrEmpty()) properties["placement"] = placement
        if (!offeringId.isNullOrEmpty()) properties["offering"] = offeringId
        return properties
    }

    /**
     * Whether RevflareKit collects app-usage events (default true). Set it to false for users who opt out: the queued
     * events are deleted and nothing is recorded or sent until it is true again. Kept on the device. Attribution,
     * purchase links and offerings are not affected.
     */
    @JvmStatic
    public var analyticsEnabled: Boolean
        get() = analyticsFlag ?: runtime?.store?.let { EventTracker.isEnabled(it) }?.also { analyticsFlag = it } ?: true
        set(value) {
            synchronized(lock) {
                analyticsFlag = value
                runtime?.store?.set(EventTracker.ENABLED_KEY, if (value) "1" else "0")
                eventPipe.send(EventCommand.SetEnabled(value))
            }
        }

    /** Events RevflareKit records itself (purchases, restores): only after [configure]. */
    internal fun trackAutomatic(name: String, properties: Map<String, String>) {
        if (runtime == null) return
        track(name, properties)
    }
}

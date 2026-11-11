import Foundation
import StoreKit
import XCTest
@testable import RevflareKit

// MARK: Fixtures

private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let day: TimeInterval = 86_400
private let installId = UUID(uuidString: "5A8B2C1D-0E3F-4A5B-8C7D-9E0F1A2B3C4D")!
private let token = UUID(uuidString: "C0FFEE00-1234-4ABC-9DEF-0123456789AB")!
private let nonce = UUID(uuidString: "2F1E3D4C-5B6A-4798-8A7B-6C5D4E3F2A1B")!
private let signatureBase64 = Data("der-es256-signature".utf8).base64EncodedString()

private let responseJSON = """
{ "productId": "com.example.app.annual", "offerId": "comeback50", "keyId": "ABC123DEFG",
  "nonce": "\(nonce.uuidString.lowercased())", "timestamp": 1792400000000,
  "signature": "\(signatureBase64)", "jws": "eyJhbGciOiJFUzI1NiJ9.eyJvZmZlciI6MX0.c2ln" }
"""

private func makeSignature(jws: String? = "eyJhbGciOiJFUzI1NiJ9.eyJvZmZlciI6MX0.c2ln", signature: String = signatureBase64,
                           appAccountToken: UUID? = token) -> RevflarePromotionalOfferSignature {
    RevflarePromotionalOfferSignature(productId: "com.example.app.annual", offerId: "comeback50", keyId: "ABC123DEFG",
                                      nonce: nonce, timestamp: 1_792_400_000_000, signature: signature, jws: jws,
                                      appAccountToken: appAccountToken)
}

private func annual(_ id: UInt64, expires: Date, group: String = "group1",
                    ownership: RevflareTransaction.Ownership = .purchased) -> RevflareTransaction {
    RevflareTransaction(id: id, productId: "com.example.app.annual", kind: .autoRenewable, subscriptionGroupId: group,
                        purchaseDate: expires.addingTimeInterval(-365 * day), expirationDate: expires, ownership: ownership)
}

// MARK: Signing request and response

final class OfferSignatureClientTests: XCTestCase {
    private var transport: FakeTransport!
    private var client: OfferSignatureClient!

    override func setUp() {
        transport = FakeTransport()
        client = OfferSignatureClient(client: ReportClient(server: URL(string: "https://revflare.example.com")!,
                                                           sdkKey: "rfp_test", transport: transport))
    }

    private func body(token: UUID? = token) -> OfferSignatureRequest {
        OfferSignatureRequest(installId: installId, productId: "com.example.app.annual", offerId: "comeback50",
                              appAccountToken: token)
    }

    func testRequestMatchesTheContract() async throws {
        transport.enqueue(.status(200, responseJSON))
        _ = try await client.sign(body())
        let request = try XCTUnwrap(transport.requests(to: "/sdk/v1/offers/sign").first)
        XCTAssertEqual(request.url?.absoluteString, "https://revflare.example.com/sdk/v1/offers/sign")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Revflare-Key"), "rfp_test")
        XCTAssertEqual(request.timeoutInterval, 10)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(json, [
            "installId": installId.uuidString.lowercased(),
            "productId": "com.example.app.annual",
            "offerId": "comeback50",
            "appAccountToken": token.uuidString.lowercased(),
        ])
    }

    func testNoAppAccountTokenIsLeftOut() throws {
        let request = try client.request(body(token: nil))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertNil(json["appAccountToken"])
        XCTAssertEqual(json.count, 3)
    }

    func testDecodesTheResponse() async throws {
        transport.enqueue(.status(200, responseJSON))
        let signature = try await client.sign(body())
        XCTAssertEqual(signature, makeSignature(appAccountToken: nil))
        XCTAssertEqual(signature.nonce, nonce)
        XCTAssertEqual(signature.timestamp, 1_792_400_000_000)
        XCTAssertEqual(signature.keyId, "ABC123DEFG")
    }

    func testMissingOrEmptyJWSDecodesAsNil() throws {
        for json in [#"{"productId":"p","offerId":"o","keyId":"K","nonce":"\#(nonce.uuidString)","timestamp":1,"signature":"c2ln"}"#,
                     #"{"productId":"p","offerId":"o","keyId":"K","nonce":"\#(nonce.uuidString)","timestamp":1,"signature":"c2ln","jws":""}"#] {
            let signature = try JSONDecoder().decode(RevflarePromotionalOfferSignature.self, from: Data(json.utf8))
            XCTAssertNil(signature.jws)
        }
        let badNonce = #"{"productId":"p","offerId":"o","keyId":"K","nonce":"nope","timestamp":1,"signature":"c2ln"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(RevflarePromotionalOfferSignature.self, from: Data(badNonce.utf8)))
    }

    private func signError(_ reply: FakeTransport.Reply) async -> RevflareOfferError? {
        transport.enqueue(reply)
        do {
            _ = try await client.sign(body())
            return nil
        } catch {
            return error as? RevflareOfferError
        }
    }

    func testErrorMapping() async {
        let forbidden = await signError(.status(403, #"{"error":"Offer not allowed","code":"offer_not_allowed"}"#))
        XCTAssertEqual(forbidden, .notAllowed("Offer not allowed"))
        let notConfigured = await signError(.status(409, #"{"error":"No In-App Purchase key","code":"not_configured"}"#))
        XCTAssertEqual(notConfigured, .notConfigured)
        let unknown = await signError(.status(404, #"{"error":"Unknown key"}"#))
        XCTAssertEqual(unknown, .unknownSDKKey)
        let limited = await signError(.response(429, #"{"error":"Too many requests"}"#, ["Retry-After": "30"]))
        XCTAssertEqual(limited, .rateLimited(retryAfter: 30))
        let limitedNoHeader = await signError(.status(429, ""))
        XCTAssertEqual(limitedNoHeader, .rateLimited(retryAfter: nil))
        let server = await signError(.status(503, ""))
        XCTAssertEqual(server, .server(status: 503))
        let network = await signError(.networkError)
        guard case .network = network else { return XCTFail("expected .network, got \(String(describing: network))") }
        let garbage = await signError(.status(200, "not json"))
        guard case .invalidResponse = garbage else { return XCTFail("expected .invalidResponse") }
        let otherOffer = await signError(.status(200, responseJSON.replacingOccurrences(of: "comeback50", with: "other")))
        guard case .invalidResponse = otherOffer else { return XCTFail("a signature for another offer must be refused") }
    }

    func testRetryAfterParsing() {
        XCTAssertEqual(OfferSignatureClient.retryAfterSeconds("120"), 120)
        XCTAssertNil(OfferSignatureClient.retryAfterSeconds(nil))
        XCTAssertNil(OfferSignatureClient.retryAfterSeconds("soon"))
        let reference = Date(timeIntervalSince1970: 1_445_412_480) // Wed, 21 Oct 2015 07:28:00 GMT
        XCTAssertEqual(OfferSignatureClient.retryAfterSeconds("Wed, 21 Oct 2015 07:28:30 GMT", now: reference), 30)
    }

    func testRevflareRequiresConfigure() async {
        // configure() is never called in the tests.
        do {
            _ = try await Revflare.promotionalOfferSignature(productId: "p", offerId: "o")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? RevflareOfferError, .sdkNotConfigured)
        }
    }
}

// MARK: Purchase options

final class PromotionalOfferOptionsTests: XCTestCase {
    func testLegacyOptionsCarryTheSignatureAndTheSameToken() throws {
        let options = try makeSignature().purchaseOptions(encoding: .legacy)
        let expected = LegacyPromotionalOffer.make(offerID: "comeback50", keyID: "ABC123DEFG", nonce: nonce,
                                                   signature: Data("der-es256-signature".utf8), timestamp: 1_792_400_000_000)
        XCTAssertEqual(options, [.appAccountToken(token), expected])
    }

    func testLegacyWithoutToken() throws {
        let options = try makeSignature(appAccountToken: nil).purchaseOptions(encoding: .legacy)
        XCTAssertEqual(options.count, 1)
    }

    func testBadSignatureThrows() {
        XCTAssertThrowsError(try makeSignature(jws: nil, signature: "%%%").purchaseOptions(encoding: .legacy)) { error in
            guard case .invalidResponse = error as? RevflareOfferError else { return XCTFail("\(error)") }
        }
    }

    func testPreferredEncodingFollowsTheCompiler() {
        #if compiler(>=6.2)
        XCTAssertEqual(PromotionalOfferEncoding.preferred, .jws)
        #else
        XCTAssertEqual(PromotionalOfferEncoding.preferred, .legacy)
        #endif
    }

    #if compiler(>=6.2)
    func testJWSOptions() throws {
        let signature = makeSignature()
        let options = try signature.purchaseOptions(encoding: .jws)
        var expected = Set(Product.PurchaseOption.promotionalOffer("comeback50", compactJWS: try XCTUnwrap(signature.jws)))
        expected.insert(.appAccountToken(token))
        XCTAssertEqual(options, expected)
        XCTAssertEqual(try signature.purchaseOptions(), expected)
    }

    func testJWSFallsBackToLegacyWithoutJWS() throws {
        let options = try makeSignature(jws: nil).purchaseOptions(encoding: .jws)
        XCTAssertEqual(options, try makeSignature(jws: nil).purchaseOptions(encoding: .legacy))
    }
    #endif
}

// MARK: Store flow

@MainActor
final class OfferPurchaseTests: XCTestCase {
    private var backend: FakePurchaseBackend!
    private var events: Locked<[(String, [String: String])]>!
    private var signed: Locked<[(String, String, UUID?)]>!
    private var signError: Locked<Error?>!

    override func setUp() async throws {
        backend = FakePurchaseBackend()
        events = Locked([])
        signed = Locked([])
        signError = Locked(nil)
    }

    private func makeStore() -> RevflareStore {
        let events = self.events!
        let signed = self.signed!
        let signError = self.signError!
        return RevflareStore(productIds: ["com.example.app.annual"],
                             mapping: EntitlementMapping(["pro": ["com.example.app.annual"]]),
                             backend: backend, productLoader: { _ in [] }, now: { now }, linkPurchases: {},
                             trackEvent: { name, properties in events.withLock { $0.append((name, properties)) } },
                             signOffer: { productId, offerId, token in
                                 signed.withLock { $0.append((productId, offerId, token)) }
                                 if let error = signError.current { throw error }
                                 return makeSignature(appAccountToken: nil)
                             },
                             start: false)
    }

    private var context: PurchaseEventContext {
        PurchaseEventContext(productId: "com.example.app.annual", placement: "winback_screen", offer: "comeback50",
                             offerType: PurchaseOfferType.promotional.rawValue)
    }

    func testPromotionalPurchaseSignsAndSendsTheSameToken() async throws {
        let store = makeStore()
        let bought = annual(10, expires: now.addingTimeInterval(365 * day))
        let used = Locked<Set<Product.PurchaseOption>>([])
        let outcome = try await store.purchasePromotional(productId: "com.example.app.annual", offerID: "comeback50",
                                                          context: context, appAccountToken: token,
                                                          encoding: .legacy) { options in
            used.withLock { $0 = options }
            return .completed(self.backend.event(bought))
        }
        XCTAssertEqual(outcome, .purchased(bought))
        XCTAssertEqual(signed.current.count, 1)
        XCTAssertEqual(signed.current.first?.0, "com.example.app.annual")
        XCTAssertEqual(signed.current.first?.1, "comeback50")
        XCTAssertEqual(signed.current.first?.2, token)
        XCTAssertTrue(used.current.contains(.appAccountToken(token)))
        XCTAssertEqual(used.current, try makeSignature(appAccountToken: token).purchaseOptions(encoding: .legacy))
        XCTAssertTrue(store.isActive("pro"))

        let expectedProps = ["product": "com.example.app.annual", "placement": "winback_screen",
                             "offer": "comeback50", "offer_type": "promotional"]
        XCTAssertEqual(events.current.map(\.0), ["purchase_start", "purchase_success"])
        XCTAssertEqual(events.current.map(\.1), [expectedProps, expectedProps])
    }

    func testSigningFailureIsAFailedPurchase() async {
        signError.withLock { $0 = RevflareOfferError.notAllowed("Offer not allowed") }
        let store = makeStore()
        let attempted = Locked(false)
        do {
            _ = try await store.purchasePromotional(productId: "com.example.app.annual", offerID: "comeback50",
                                                    context: context, appAccountToken: token) { _ in
                attempted.withLock { $0 = true }
                return .userCancelled
            }
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? RevflareOfferError, .notAllowed("Offer not allowed"))
        }
        XCTAssertFalse(attempted.current, "StoreKit is not called without a signature")
        XCTAssertFalse(store.isPurchasing)
        XCTAssertEqual(events.current.map(\.0), ["purchase_start", "purchase_failed"])
        XCTAssertEqual(events.current.last?.1["error"], "offer_not_allowed")
        XCTAssertEqual(events.current.last?.1["offer_type"], "promotional")
    }

    func testCancelledOfferPurchase() async throws {
        let store = makeStore()
        let outcome = try await store.purchasePromotional(productId: "com.example.app.annual", offerID: "comeback50",
                                                          context: context, appAccountToken: token) { _ in .userCancelled }
        XCTAssertEqual(outcome, .userCancelled)
        XCTAssertEqual(events.current.map(\.0), ["purchase_start", "purchase_cancel"])
        XCTAssertEqual(events.current.last?.1["offer"], "comeback50")
    }

    func testWinBackEventProperties() {
        let context = PurchaseEventContext(productId: "p", offering: "default", package: "$annual", placement: "home",
                                           offer: "wb1", offerType: PurchaseOfferType.winBack.rawValue)
        XCTAssertEqual(context.properties, ["product": "p", "offering": "default", "package": "$annual",
                                            "placement": "home", "offer": "wb1", "offer_type": "win_back"])
        XCTAssertEqual(PurchaseEventContext(productId: "p").properties, ["product": "p"])
    }

    func testOfferErrorCodes() {
        let codes: [(RevflareOfferError, String)] = [
            (.notAllowed(""), "offer_not_allowed"), (.notConfigured, "offer_not_configured"),
            (.unknownSDKKey, "offer_unknown_sdk_key"), (.rateLimited(retryAfter: 5), "offer_rate_limited"),
            (.network("x"), "offer_network_error"), (.server(status: 500), "offer_server_error"),
            (.invalidResponse("x"), "offer_invalid_response"), (.sdkNotConfigured, "offer_sdk_not_configured"),
        ]
        for (error, code) in codes { XCTAssertEqual(PurchaseEventContext.errorCode(error), code) }
    }

    // MARK: Eligibility

    func testPromotionalEligibilityNeedsSubscriptionHistory() async {
        var eligible = await makeStore().hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertFalse(eligible, "never subscribed")

        backend.purchasedGroups.withLock { $0 = ["group2"] }
        eligible = await makeStore().hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertFalse(eligible, "subscribed in another group only")

        backend.purchasedGroups.withLock { $0 = ["group1"] }
        eligible = await makeStore().hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertTrue(eligible, "had a subscription (Transaction.all)")
    }

    func testPurchasedGroupsAreCachedUntilANewTransactionOrRestore() async throws {
        let store = makeStore()
        let check = { await store.hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual") }
        var eligible = await check()
        XCTAssertFalse(eligible)
        backend.purchasedGroups.withLock { $0 = ["group1"] }
        eligible = await check()
        XCTAssertFalse(eligible, "Transaction.all is read once")
        XCTAssertEqual(backend.purchasedGroupsCalls.current, 1)

        // A new transaction (Transaction.updates, a purchase) invalidates the cache.
        await store.handle(TransactionEvent(transaction: annual(7, expires: now.addingTimeInterval(-day)), verificationError: nil, finish: {}))
        eligible = await check()
        XCTAssertTrue(eligible)
        XCTAssertEqual(backend.purchasedGroupsCalls.current, 2)
        _ = await check()
        XCTAssertEqual(backend.purchasedGroupsCalls.current, 2)

        // So does a restore.
        try await store.restore()
        _ = await check()
        XCTAssertEqual(backend.purchasedGroupsCalls.current, 3)
    }

    func testPromotionalEligibilityFromStatuses() async {
        let store = makeStore()
        let shared = annual(1, expires: now.addingTimeInterval(-day), ownership: .familyShared)
        backend.statuses.withLock { $0 = [SubscriptionStatusRecord(state: .expired, transaction: shared, willAutoRenew: false)] }
        var eligible = await store.hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertFalse(eligible, "family-shared access is not the customer's own subscription")

        let own = annual(2, expires: now.addingTimeInterval(-day))
        backend.statuses.withLock { $0 = [SubscriptionStatusRecord(state: .expired, transaction: own, willAutoRenew: false)] }
        eligible = await store.hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertTrue(eligible)
        XCTAssertEqual(backend.requestedGroups.current.last, ["group1": "com.example.app.annual"])
    }

    func testCurrentSubscribersAreEligibleForPromotionalOffers() async {
        backend.entitlements.withLock { $0 = [annual(3, expires: now.addingTimeInterval(30 * day))] }
        let store = makeStore()
        await store.refresh()
        let eligible = await store.hasSubscriptionHistory(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertTrue(eligible)
    }

    func testWinBackEligibilityFromRenewalInfo() async {
        let store = makeStore()
        let lapsed = annual(1, expires: now.addingTimeInterval(-10 * day))
        let other = annual(2, expires: now.addingTimeInterval(-10 * day), group: "group2")
        backend.statuses.withLock {
            $0 = [SubscriptionStatusRecord(state: .expired, transaction: lapsed, willAutoRenew: false,
                                           eligibleWinBackOfferIds: ["wb_best", "wb_other"]),
                  SubscriptionStatusRecord(state: .expired, transaction: other, willAutoRenew: false,
                                           eligibleWinBackOfferIds: ["wb_group2"]),
                  SubscriptionStatusRecord(state: .expired, transaction: lapsed, willAutoRenew: false,
                                           eligibleWinBackOfferIds: ["wb_best"])]
        }
        let ids = await store.eligibleWinBackOfferIds(groupId: "group1", productId: "com.example.app.annual")
        XCTAssertEqual(ids, ["wb_best", "wb_other"])
    }

    func testMatchingKeepsEligibleOrderAndDropsUnknown() {
        struct Offer: Equatable { var id: String? }
        let offers = [Offer(id: "a"), Offer(id: "b"), Offer(id: nil), Offer(id: "c")]
        XCTAssertEqual(OfferEligibility.matching(offers, eligibleIds: ["c", "x", "a"], id: \.id), [Offer(id: "c"), Offer(id: "a")])
        XCTAssertEqual(OfferEligibility.matching(offers, eligibleIds: [], id: \.id), [])
    }
}

// MARK: Lapsed subscribers

final class LapsedSubscriptionTests: XCTestCase {
    private let mapping = EntitlementMapping(["pro": ["com.example.app.annual"], "other": ["com.example.other"]])

    private func customer(_ transactions: [RevflareTransaction], _ statuses: [SubscriptionStatusRecord]) -> CustomerEntitlements {
        CustomerEntitlements.compute(transactions: transactions, statuses: statuses, mapping: mapping, now: now)
    }

    func testExpiredSubscriptionIsLapsed() throws {
        let expired = annual(1, expires: now.addingTimeInterval(-10 * day))
        let result = customer([], [SubscriptionStatusRecord(state: .expired, transaction: expired, willAutoRenew: false)])
        let lapsed = try XCTUnwrap(result.lapsedSubscription(groupID: "group1"))
        XCTAssertEqual(lapsed.productId, "com.example.app.annual")
        XCTAssertNil(result.lapsedSubscription(groupID: "group2"))
        XCTAssertTrue(result.isLapsed(entitlement: "pro", mapping: mapping))
        XCTAssertFalse(result.isLapsed(entitlement: "other", mapping: mapping))
        XCTAssertFalse(result.isLapsed(entitlement: "unknown", mapping: mapping))
    }

    func testBillingRetryAndGraceAreNotLapsed() {
        let failed = annual(1, expires: now.addingTimeInterval(-day))
        let retry = customer([], [SubscriptionStatusRecord(state: .inBillingRetryPeriod, transaction: failed, willAutoRenew: true)])
        XCTAssertNil(retry.lapsedSubscription(groupID: "group1"), "billing retry: nudge a payment update instead")
        XCTAssertFalse(retry.isLapsed(entitlement: "pro", mapping: mapping))
        let grace = customer([], [SubscriptionStatusRecord(state: .inGracePeriod, transaction: failed, willAutoRenew: true,
                                                           gracePeriodExpirationDate: now.addingTimeInterval(3 * day))])
        XCTAssertNil(grace.lapsedSubscription(groupID: "group1"))
        XCTAssertFalse(grace.isLapsed(entitlement: "pro", mapping: mapping))
    }

    func testActiveRefundedAndNeverSubscribedAreNotLapsed() {
        let active = annual(1, expires: now.addingTimeInterval(day))
        XCTAssertNil(customer([active], []).lapsedSubscription(groupID: "group1"))
        XCTAssertFalse(customer([active], []).isLapsed(entitlement: "pro", mapping: mapping))
        let refunded = annual(2, expires: now.addingTimeInterval(-day))
        let revoked = customer([], [SubscriptionStatusRecord(state: .revoked, transaction: refunded, willAutoRenew: false)])
        XCTAssertNil(revoked.lapsedSubscription(groupID: "group1"))
        XCTAssertNil(customer([], []).lapsedSubscription(groupID: "group1"))
        XCTAssertFalse(customer([], []).isLapsed(entitlement: "pro", mapping: mapping))
    }

    @MainActor
    func testStoreHelpers() async {
        let backend = FakePurchaseBackend()
        let expired = annual(1, expires: now.addingTimeInterval(-10 * day))
        backend.statuses.withLock { $0 = [SubscriptionStatusRecord(state: .expired, transaction: expired, willAutoRenew: false)] }
        backend.entitlements.withLock { $0 = [expired] }
        let store = RevflareStore(productIds: ["com.example.app.annual"], mapping: mapping, backend: backend,
                                  productLoader: { _ in [] }, now: { now }, linkPurchases: {}, trackEvent: { _, _ in },
                                  start: false)
        await store.refresh()
        XCTAssertEqual(store.lapsedSubscription(groupID: "group1")?.productId, "com.example.app.annual")
        XCTAssertTrue(store.isLapsed(entitlement: "pro"))
    }
}

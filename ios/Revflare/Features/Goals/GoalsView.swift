import SwiftUI

/// The last goals the app loaded, so a goal's detail opens with numbers before its own request returns.
@MainActor
enum GoalStore {
    static var latest: [String: GoalProgress] = [:]
    static var currency: String?

    static func remember(_ goals: [GoalProgress], currency: String?) {
        for g in goals { latest[g.id] = g }
        if let currency { self.currency = currency }
    }
}

// MARK: - Shared pieces

/// Pace: on track, behind, reached, missed, upcoming.
struct PaceBadge: View {
    var pace: String
    var compact = false

    var body: some View {
        let color = GoalPace.color(pace)
        HStack(spacing: 3) {
            Image(systemName: GoalPace.systemImage(pace)).imageScale(.small)
            Text(GoalPace.title(pace))
        }
            .font((compact ? Font.caption2 : .caption).weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, compact ? 6 : 8)
            .padding(.vertical, compact ? 2 : 3)
            .background(color.opacity(0.13), in: Capsule())
            .lineLimit(1)
            .fixedSize()
            .accessibilityElement(children: .combine)
    }
}

/// A goal's progress bar with a tick where a linear path to the target would be today.
struct GoalProgressBar: View {
    var progress: Double
    /// expected / target (0...1), nil to hide the tick.
    var expected: Double?
    var color: Color = .brand
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(color.opacity(0.15))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.75), color], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(progress > 0 ? height : 0, w * min(max(progress, 0), 1)))
                if let expected, expected > 0, expected < 1 {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.primary.opacity(0.55))
                        .frame(width: 2, height: height + 6)
                        .offset(x: w * expected - 1)
                }
            }
        }
        .frame(height: height + 6)
        .animation(.smooth(duration: 0.6), value: progress)
        .accessibilityHidden(true)
    }
}

extension GoalProgress {
    var tint: Color { isReached ? .green : (paceValue == "missed" ? .red : .brand) }

    /// expected / target for the bar's tick (active periods only).
    var expectedFraction: Double? {
        guard status == "active", let expected, target > 0, !isReached else { return nil }
        return expected / target
    }
}

/// An amount of a goal's metric: money is privacy-sensitive, counts are not.
struct GoalValueText: View {
    var goal: GoalProgress
    var value: Double
    var currency: String
    var compact = false

    var body: some View {
        if goal.isMoney {
            MoneyText(value: value, currency: currency, compact: compact)
        } else {
            Text(goal.formatted(value, currency: currency, compact: compact)).monospacedDigit()
        }
    }
}

/// One goal in a list or on the overview: name, scope, bar, current / target, pace and time left.
struct GoalSummaryRow: View {
    @Environment(AppModel.self) private var model
    var goal: GoalProgress
    var currency: String
    var showMeta = true

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(goal.title(appName: model.appName)).font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 6)
                Text(Fmt.percent(min(goal.progress, 9.99)))
                    .font(.headline)
                    .monospacedDigit()
                    .foregroundStyle(goal.isReached ? Color.green : Color.primary)
            }
            GoalProgressBar(progress: goal.progress, expected: goal.expectedFraction, color: goal.tint)
            HStack(spacing: 6) {
                HStack(spacing: 3) {
                    GoalValueText(goal: goal, value: goal.current, currency: currency, compact: true).fontWeight(.semibold)
                    Text("/").foregroundStyle(.secondary)
                    GoalValueText(goal: goal, value: goal.target, currency: currency, compact: true).foregroundStyle(.secondary)
                }
                .lineLimit(1)
                Spacer(minLength: 6)
                if showMeta {
                    Text(goal.timeLeft).foregroundStyle(.secondary).lineLimit(1)
                    PaceBadge(pace: goal.paceValue, compact: true)
                }
            }
            .font(.caption)
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        var parts: [String] = []
        if goal.name?.isEmpty == false { parts.append(GoalMetric.title(goal.metric)); parts.append(goal.scopeSummary(appName: model.appName)) }
        parts.append(goal.periodTitle)
        return parts.joined(separator: " · ")
    }
}

// MARK: - List

/// Goals: list (active, then archived), reorder, archive, delete, create and edit (`/goals`).
struct GoalsView: View {
    @Environment(AppModel.self) private var model
    @State private var goals: [GoalProgress] = []
    @State private var currency: String?
    @State private var loaded = false
    @State private var loading = false
    @State private var error: String?
    @State private var editor: GoalEditorTarget?
    @State private var showArchived = false
    @State private var pendingDelete: GoalProgress?

    private var active: [GoalProgress] { goals.filter { !$0.archived } }
    private var archived: [GoalProgress] { goals.filter(\.archived) }
    private var cur: String { currency ?? model.currency }

    var body: some View {
        List {
            if let error { ErrorBanner(message: error) { Task { await load() } }.listRowBackground(Color.clear) }
            if goals.isEmpty && loaded && model.quotaResetAt == nil {
                ContentUnavailableView {
                    Label("No goals yet", systemImage: "target")
                } description: {
                    Text("Set a target for revenue, MRR, subscriptions or trials, for a week, month, quarter, year or your own dates.")
                } actions: {
                    if model.canManage {
                        Button("Add a goal") { editor = GoalEditorTarget(goal: nil) }.buttonStyle(.borderedProminent)
                    }
                }
                .listRowBackground(Color.clear)
            }
            if !active.isEmpty {
                Section {
                    ForEach(active) { g in
                        row(g)
                    }
                    .onMove(perform: model.canManage ? move : nil)
                } footer: {
                    if !model.canManage { Text("Only owners and admins can change goals.") }
                }
            }
            if !archived.isEmpty {
                Section(isExpanded: $showArchived) {
                    ForEach(archived) { g in row(g) }
                } header: {
                    Text("Archived (\(archived.count))")
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Goals")
        .toolbar {
            if model.canManage {
                if active.count > 1 {
                    ToolbarItem(placement: .topBarTrailing) { EditButton() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editor = GoalEditorTarget(goal: nil)
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel(Text("Add goal"))
                }
            }
        }
        .sheet(item: $editor) { target in
            GoalEditorSheet(goal: target.goal, currency: cur) { _ in
                await load()
                model.dataChanged()
            }
        }
        .confirmationDialog(deleteTitle, isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible) {
            Button("Delete goal", role: .destructive) {
                if let g = pendingDelete { Task { await delete(g) } }
            }
        } message: {
            Text("Its progress history is not kept.")
        }
        .task(id: model.dataVersion) { await load() }
        .refreshable { await load() }
    }

    private var deleteTitle: String {
        guard let g = pendingDelete else { return "" }
        return String(localized: "Delete “\(g.title(appName: model.appName))”?")
    }

    @ViewBuilder private func row(_ g: GoalProgress) -> some View {
        NavigationLink(value: Route.goal(id: g.id)) {
            GoalSummaryRow(goal: g, currency: cur)
                .padding(.vertical, 4)
                .opacity(g.archived ? 0.6 : 1)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if model.canManage {
                Button {
                    pendingDelete = g
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .tint(.red)
                Button {
                    Task { await setArchived(g, !g.archived) }
                } label: {
                    if g.archived {
                        Label("Unarchive", systemImage: "tray.and.arrow.up")
                    } else {
                        Label("Archive", systemImage: "archivebox")
                    }
                }
                .tint(.indigo)
            }
        }
        .swipeActions(edge: .leading) {
            if model.canManage {
                Button {
                    editor = GoalEditorTarget(goal: g)
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .tint(.brand)
            }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        loading = true
        defer { loading = false; loaded = true }
        do {
            let list = try await client.goals()
            goals = list.items
            currency = list.currency
            GoalStore.remember(list.items, currency: list.currency)
            error = nil
        } catch {
            self.error = model.handle(error)
        }
    }

    private func move(_ from: IndexSet, _ to: Int) {
        var order = active
        order.move(fromOffsets: from, toOffset: to)
        goals = order + archived
        let ids = goals.map(\.id)
        Task {
            do {
                try await model.client?.reorderGoals(ids)
                model.dataChanged()
            } catch {
                self.error = model.handle(error)
                await load()
            }
        }
    }

    private func setArchived(_ g: GoalProgress, _ value: Bool) async {
        do {
            try await model.client?.setGoalArchived(g.id, value)
            withAnimation {
                if let i = goals.firstIndex(where: { $0.id == g.id }) { goals[i].archived = value }
            }
            model.dataChanged()
        } catch {
            self.error = model.handle(error)
        }
    }

    private func delete(_ g: GoalProgress) async {
        pendingDelete = nil
        do {
            try await model.client?.deleteGoal(g.id)
            withAnimation { goals.removeAll { $0.id == g.id } }
            GoalStore.latest[g.id] = nil
            model.dataChanged()
        } catch {
            self.error = model.handle(error)
        }
    }
}

struct GoalEditorTarget: Identifiable {
    var id = UUID()
    var goal: GoalProgress?
}

// MARK: - Detail

/// One goal: progress, pace, what is needed, projection, the period and the previous one.
struct GoalDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var goalId: String

    @State private var goal: GoalProgress?
    @State private var currency: String?
    @State private var error: String?
    @State private var notFound = false
    @State private var editing = false
    @State private var confirmDelete = false

    private var cur: String { currency ?? GoalStore.currency ?? model.currency }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let error { ErrorBanner(message: error) { Task { await load() } } }
                if let goal {
                    header(goal)
                    progressCard(goal)
                    statsGrid(goal)
                    periodCard(goal)
                    appsCard(goal)
                } else if notFound {
                    ContentUnavailableView("Goal not found", systemImage: "target", description: Text("It may have been deleted."))
                } else {
                    ProgressView().padding(.top, 60)
                }
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(goal.map { $0.title(appName: model.appName) } ?? String(localized: "Goal"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canManage, let goal {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { editing = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            Task { await setArchived(!goal.archived) }
                        } label: {
                            if goal.archived {
                                Label("Unarchive", systemImage: "tray.and.arrow.up")
                            } else {
                                Label("Archive", systemImage: "archivebox")
                            }
                        }
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Delete goal", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel(Text("More"))
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let goal {
                GoalEditorSheet(goal: goal, currency: cur) { saved in
                    self.goal = saved
                    GoalStore.remember([saved], currency: nil)
                    model.dataChanged()
                }
            }
        }
        .confirmationDialog("Delete goal", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete goal", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Its progress history is not kept.")
        }
        .task(id: model.dataVersion) {
            if goal == nil { goal = GoalStore.latest[goalId] }
            await load()
        }
        .refreshable { await load() }
    }

    // Header: ring, name, scope, period, pace.
    private func header(_ g: GoalProgress) -> some View {
        HStack(spacing: 16) {
            ProgressRing(progress: g.progress, lineWidth: 10, color: g.isReached ? .green : .brand)
                .frame(width: 92, height: 92)
                .overlay {
                    VStack(spacing: 0) {
                        Text(Fmt.percent(min(g.progress, 9.99)))
                            .font(.system(.title3, design: .rounded).weight(.bold))
                            .monospacedDigit()
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Image(systemName: GoalMetric.systemImage(g.metric)).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(14)
                }
            VStack(alignment: .leading, spacing: 5) {
                Text(g.title(appName: model.appName)).font(.title3.weight(.bold)).lineLimit(2)
                if g.name?.isEmpty == false {
                    Text(g.generatedLabel(appName: model.appName)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                Text(g.periodTitle).font(.subheadline).foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    PaceBadge(pace: g.paceValue)
                    if g.archived {
                        Text("Archived").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .card()
    }

    // Current / target, bar with today's expected value.
    private func progressCard(_ g: GoalProgress) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(g.isStock ? "Now" : "So far").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    GoalValueText(goal: g, value: g.current, currency: cur)
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Target").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    GoalValueText(goal: g, value: g.target, currency: cur).font(.title3.weight(.semibold)).lineLimit(1)
                }
            }
            GoalProgressBar(progress: g.progress, expected: g.expectedFraction, color: g.tint, height: 12)
            HStack {
                if let expected = g.expected, g.expectedFraction != nil {
                    HStack(spacing: 4) {
                        Image(systemName: "line.diagonal").rotationEffect(.degrees(45))
                        Text("Expected by now")
                        GoalValueText(goal: g, value: expected, currency: cur, compact: true)
                    }
                    .foregroundStyle(.secondary)
                }
                Spacer()
                Text(g.timeLeft).foregroundStyle(.secondary)
            }
            .font(.caption)
            .lineLimit(1)
        }
        .card()
    }

    private func statsGrid(_ g: GoalProgress) -> some View {
        let tiles = statTiles(g)
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(tiles) { t in
                VStack(alignment: .leading, spacing: 4) {
                    Label(t.title, systemImage: t.systemImage).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                    Group {
                        if let value = t.value {
                            GoalValueText(goal: g, value: value, currency: cur, compact: true)
                        } else {
                            Text(t.text ?? "")
                        }
                    }
                    .font(.title3.weight(.bold))
                    .foregroundStyle(t.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    Text(t.caption ?? " ").font(.caption2).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                }
                .card(padding: 14)
            }
        }
    }

    private struct Tile: Identifiable {
        var id: String
        var title: String
        var systemImage: String
        var value: Double?
        var text: String?
        var caption: String?
        var color: Color = .primary
    }

    private func statTiles(_ g: GoalProgress) -> [Tile] {
        var tiles: [Tile] = []
        let active = g.status == "active"
        if active, let delta = g.delta, !g.isReached {
            let ahead = delta >= 0
            tiles.append(Tile(id: "delta", title: ahead ? String(localized: "Ahead") : String(localized: "Behind"), systemImage: ahead ? "hare" : "tortoise",
                              value: abs(delta), caption: String(localized: "Compared with a steady pace"), color: ahead ? .green : .orange))
        }
        if active, let perDay = g.requiredPerDay, !g.isReached {
            tiles.append(Tile(id: "perDay", title: String(localized: "Needed per day"), systemImage: "calendar.badge.clock", value: perDay,
                              caption: g.daysLeft > 0 ? String(localized: "For the \(g.daysLeft + 1) days left, today included") : String(localized: "Today")))
        }
        if !g.isStock, g.status != "upcoming" {
            tiles.append(Tile(id: "projected", title: String(localized: "Projected"), systemImage: "chart.line.uptrend.xyaxis", value: g.projected,
                              caption: active ? String(localized: "End of period at this pace") : String(localized: "End of period"),
                              color: g.projected >= g.target ? .green : .primary))
        }
        if g.isStock, let start = g.startValue {
            tiles.append(Tile(id: "start", title: String(localized: "Start of period"), systemImage: "flag", value: start, caption: g.periodStart.flatMap(Self.dayText)))
            let change = g.current - start
            let sign = change > 0 ? "+" : (change < 0 ? "−" : "")
            tiles.append(Tile(id: "change", title: String(localized: "Change in period"), systemImage: "arrow.up.arrow.down",
                              text: sign + g.formatted(abs(change), currency: cur, compact: true, hide: model.privacyMode && g.isMoney),
                              caption: nil, color: change > 0 ? .green : (change < 0 ? .red : .primary)))
        }
        if let reached = g.reachedAt {
            tiles.append(Tile(id: "reached", title: String(localized: "Reached"), systemImage: "checkmark.seal", text: Self.dayText(reached) ?? reached,
                              caption: nil, color: .green))
        }
        // Days fill the grid's last cell (the progress card already says how many are left).
        if tiles.count % 2 == 1 {
            tiles.append(Tile(id: "days", title: String(localized: "Days"), systemImage: "hourglass",
                          text: g.status == "active" ? String(localized: "\(g.daysLeft) left") : g.timeLeft,
                              caption: g.daysTotal > 0 ? String(localized: "Day \(min(g.daysElapsed, g.daysTotal)) of \(g.daysTotal)") : nil))
        }
        return tiles
    }

    private func periodCard(_ g: GoalProgress) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Period", systemImage: "calendar")
            row("Period", g.periodDates ?? g.periodTitle)
            row("Repeats", GoalPeriod.cadence(g.period))
            if let p = g.previous {
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Previous period").font(.subheadline)
                        if let s = Fmt.day(p.periodStart), let e = Fmt.day(p.periodEnd) {
                            Text(GoalProgress.range(s, e)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        GoalValueText(goal: g, value: p.value, currency: cur).font(.subheadline.weight(.semibold))
                        PaceBadge(pace: p.reached ? "reached" : "missed", compact: true)
                    }
                }
            }
            Divider()
            HStack {
                Label(g.notify ? "Notifies when reached" : "No notification", systemImage: g.notify ? "bell.badge" : "bell.slash")
                    .font(.subheadline)
                    .foregroundStyle(g.notify ? Color.primary : Color.secondary)
                Spacer()
            }
        }
        .card()
    }

    private func appsCard(_ g: GoalProgress) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: g.scope == "exclude" ? "All apps except" : "Apps", systemImage: "square.grid.2x2")
            if g.scope == "all" || g.appIds.isEmpty {
                Text("All apps").font(.subheadline)
            } else {
                ForEach(g.appIds, id: \.self) { id in
                    let app = model.apps.first { $0.id == id }
                    HStack(spacing: 10) {
                        AppIconView(url: app?.iconUrl, name: app?.name ?? id, size: 26)
                        Text(app?.name ?? id).font(.subheadline).lineLimit(1)
                        Spacer()
                    }
                }
                if g.scope == "exclude" {
                    Text("Apps added later count too.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .card()
    }

    private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.subheadline)
            Spacer()
            Text(value).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
        }
    }

    static func dayText(_ day: String) -> String? {
        Fmt.day(day)?.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).day().month(.abbreviated).year())
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            let r = try await client.goal(goalId)
            goal = r.goal
            currency = r.currency
            GoalStore.remember([r.goal], currency: r.currency)
            error = nil
        } catch let APIError.server(status, _) where status == 404 {
            notFound = true
            goal = nil
        } catch {
            if goal == nil { self.error = model.handle(error) } else { _ = model.handle(error) }
        }
    }

    private func setArchived(_ value: Bool) async {
        do {
            if let r = try await model.client?.setGoalArchived(goalId, value) { goal = r.goal }
            model.dataChanged()
        } catch {
            self.error = model.handle(error)
        }
    }

    private func delete() async {
        do {
            try await model.client?.deleteGoal(goalId)
            GoalStore.latest[goalId] = nil
            model.dataChanged()
            dismiss()
        } catch {
            self.error = model.handle(error)
        }
    }
}

// MARK: - Editor

/// Create or edit a goal: name, metric, target, period (or custom dates), app scope, notification.
struct GoalEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var goal: GoalProgress?
    var currency: String
    var onSave: (GoalProgress) async -> Void

    @State private var name = ""
    @State private var metric = "revenue"
    @State private var target: Double?
    @State private var period = "month"
    @State private var startDay = Calendar.current.startOfDay(for: .now)
    @State private var endDay = Calendar.current.date(byAdding: .day, value: 29, to: Calendar.current.startOfDay(for: .now)) ?? .now
    @State private var scope = "all"
    @State private var appIds: Set<String> = []
    @State private var notify = true
    @State private var saving = false
    @State private var error: String?
    @State private var appSearch = ""

    static let nameLimit = 60

    private var isMoney: Bool { GoalMetric.isMoney(metric) }
    private var datesValid: Bool { period != "custom" || endDay >= startDay }
    private var scopeValid: Bool { scope == "all" || !appIds.isEmpty }
    private var canSave: Bool { (target ?? 0) > 0 && datesValid && scopeValid && !saving }

    private var apps: [RFApp] {
        // Archived apps stay listed when the goal already uses them.
        model.apps.filter { !$0.archived || appIds.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name (optional)", text: $name)
                        .onChange(of: name) { _, v in if v.count > Self.nameLimit { name = String(v.prefix(Self.nameLimit)) } }
                        .submitLabel(.done)
                } header: {
                    Text("Name")
                } footer: {
                    HStack(alignment: .top) {
                        if name.trimmingCharacters(in: .whitespaces).isEmpty {
                            Text("Shown as “\(preview.generatedLabel(appName: model.appName))”")
                        }
                        Spacer()
                        Text("\(name.count)/\(Self.nameLimit)").monospacedDigit()
                    }
                }

                Section {
                    Picker("Metric", selection: $metric) {
                        Section("Money") {
                            ForEach(GoalMetric.money, id: \.self) { m in
                                Label(GoalMetric.title(m), systemImage: GoalMetric.systemImage(m)).tag(m)
                            }
                        }
                        Section("Counts") {
                            ForEach(GoalMetric.counts, id: \.self) { m in
                                Label(GoalMetric.title(m), systemImage: GoalMetric.systemImage(m)).tag(m)
                            }
                        }
                    }
                    targetField
                } header: {
                    Text("What to reach")
                } footer: {
                    Text(GoalMetric.isStock(metric)
                        ? String(localized: "A level: reached when today's value hits the target.")
                        : String(localized: "Adds up over the period."))
                }

                Section {
                    Picker("Period", selection: $period) {
                        ForEach(GoalPeriod.all, id: \.self) { p in Text(GoalPeriod.title(p)).tag(p) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    if period == "custom" {
                        DatePicker("Starts", selection: $startDay, displayedComponents: .date)
                        DatePicker("Ends", selection: $endDay, in: startDay..., displayedComponents: .date)
                    }
                } header: {
                    Text("Period")
                } footer: {
                    if !datesValid {
                        Text("The end date must be on or after the start date.").foregroundStyle(.red)
                    } else if period == "custom" {
                        Text("Runs from the first to the last day (UTC days), then ends.")
                    } else {
                        Text(Self.repeatsFooter(period))
                    }
                }

                Section {
                    Picker("Apps", selection: $scope) {
                        Text("All apps").tag("all")
                        Text("Selected").tag("include")
                        Text("All except").tag("exclude")
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    if scope != "all" {
                        if apps.count > 8 {
                            TextField("Search apps", text: $appSearch)
                        }
                        ForEach(apps.filter { appSearch.isEmpty || $0.name.localizedCaseInsensitiveContains(appSearch) }) { app in
                            Button {
                                if appIds.contains(app.id) { appIds.remove(app.id) } else { appIds.insert(app.id) }
                            } label: {
                                HStack(spacing: 12) {
                                    AppIconView(url: app.iconUrl, name: app.name, size: 28)
                                    Text(app.name).foregroundStyle(.primary).lineLimit(1)
                                    Spacer()
                                    Image(systemName: appIds.contains(app.id) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(appIds.contains(app.id) ? Color.brand : Color.secondary)
                                        .font(.title3)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: {
                    Text("Apps")
                } footer: {
                    switch scope {
                    case "include": Text(appIds.isEmpty ? "Pick at least one app." : "Counts only the selected apps.")
                            .foregroundStyle(appIds.isEmpty ? Color.red : Color.secondary)
                    case "exclude": Text(appIds.isEmpty ? "Pick at least one app to leave out." : "Counts every app except the selected ones, apps added later too.")
                            .foregroundStyle(appIds.isEmpty ? Color.red : Color.secondary)
                    default: Text("Counts every app of the workspace.")
                    }
                }

                Section {
                    Toggle(isOn: $notify) {
                        Label("Notify me when reached", systemImage: "bell.badge")
                    }
                } footer: {
                    Text("A notification on your devices, once per period.")
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(goal == nil ? "New goal" : "Edit goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }.disabled(!canSave)
                    }
                }
            }
            .onAppear(perform: fill)
            .interactiveDismissDisabled(saving)
        }
    }

    @ViewBuilder private var targetField: some View {
        HStack {
            Text("Target")
            Spacer()
            Group {
                if isMoney {
                    TextField("Target", value: $target, format: .currency(code: currency).precision(.fractionLength(0...2)))
                        .keyboardType(.decimalPad)
                } else {
                    TextField("Target", value: $target, format: .number.precision(.fractionLength(0)))
                        .keyboardType(.numberPad)
                }
            }
            .multilineTextAlignment(.trailing)
            .font(.headline)
            .monospacedDigit()
        }
    }

    /// What the goal would look like (for the generated label).
    private var preview: GoalProgress {
        GoalProgress(id: "preview", metric: metric, period: period, target: target ?? 0, scope: scope, appIds: Array(appIds),
                     current: 0, progress: 0, projected: 0, periodLabel: "")
    }

    static func repeatsFooter(_ period: String) -> String {
        switch period {
        case "week": String(localized: "Starts over every Monday (UTC days).")
        case "quarter": String(localized: "Starts over every quarter (UTC days).")
        case "year": String(localized: "Starts over every year (UTC days).")
        default: String(localized: "Starts over every month (UTC days).")
        }
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private func fill() {
        guard let g = goal else { return }
        name = g.name ?? ""
        metric = g.metric
        target = g.target
        period = g.period
        if let s = g.startDate.flatMap(Self.dayFormatter.date) { startDay = s }
        if let e = g.endDate.flatMap(Self.dayFormatter.date) { endDay = e }
        scope = g.scope
        appIds = Set(g.appIds)
        notify = g.notify
    }

    private func save() async {
        guard let client = model.client, let target, target > 0 else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let custom = period == "custom"
        let input = GoalInput(
            name: trimmed.isEmpty ? nil : trimmed,
            metric: metric,
            target: isMoney ? target : target.rounded(),
            period: period,
            startDate: custom ? Self.dayFormatter.string(from: startDay) : nil,
            endDate: custom ? Self.dayFormatter.string(from: endDay) : nil,
            scope: scope,
            appIds: scope == "all" ? [] : appIds.sorted(),
            notify: notify
        )
        saving = true
        defer { saving = false }
        do {
            let r: GoalResponse
            if let goal {
                // PATCH only what changed (like the web): saving the same definition back must not re-arm the push.
                var patch = GoalPatch()
                if input.name != goal.name { patch.name = .some(input.name) }
                if input.metric != goal.metric { patch.metric = input.metric }
                if input.target != goal.target { patch.target = input.target }
                if input.period != goal.period { patch.period = input.period }
                if input.startDate != goal.startDate || input.endDate != goal.endDate { patch.dates = (input.startDate, input.endDate) }
                if input.scope != goal.scope { patch.scope = input.scope }
                if input.appIds.sorted() != goal.appIds.sorted() { patch.appIds = input.appIds }
                if input.notify != goal.notify { patch.notify = input.notify }
                if patch.isEmpty {
                    dismiss()
                    return
                }
                r = try await client.updateGoal(goal.id, patch)
            } else {
                r = try await client.createGoal(input)
            }
            await onSave(r.goal)
            dismiss()
        } catch {
            self.error = model.handle(error) ?? error.localizedDescription
        }
    }
}

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Params = imports.misc.params;

const Main = imports.ui.main;
const Dash = imports.ui.dash;
const IconGrid = imports.ui.iconGrid;
const Overview = imports.ui.overview;
const OverviewControls = imports.ui.overviewControls;
const PointerWatcher = imports.ui.pointerWatcher;
const Signals = imports.signals;
const SearchController = imports.ui.searchController;
const WorkspaceSwitcherPopup= imports.ui.workspaceSwitcherPopup;
const Layout = imports.ui.layout;
const LayoutManager = imports.ui.main.layoutManager;
const Workspace = imports.ui.workspace;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const Intellihide = Me.imports.intellihide;
const Theming = Me.imports.theming;
const MyDash = Me.imports.dash;
const LauncherAPI = Me.imports.launcherAPI;
const FileManager1API = Me.imports.fileManager1API;

const DOCK_DWELL_CHECK_INTERVAL = 100;

var State = {
    HIDDEN:  0,
    SHOWING: 1,
    SHOWN:   2,
    HIDING:  3
};

const scrollAction = {
    DO_NOTHING: 0,
    CYCLE_WINDOWS: 1,
    SWITCH_WORKSPACE: 2
};

/**
 * A simple St.Widget with one child whose allocation takes into account the
 * slide out of its child via the slide-x property ([0:1]).
 *
 * Required since I want to track the input region of this container which is
 * based on its allocation even if the child overlows the parent actor. By doing
 * this the region of the dash that is slideout is not steling anymore the input
 * regions making the extesion usable when the primary monitor is the right one.
 *
 * The slide-x parameter can be used to directly animate the sliding. The parent
 * must have a WEST (SOUTH) anchor_point to achieve the sliding to the RIGHT (BOTTOM)
 * side.
*/
var DashSlideContainer = GObject.registerClass({
    Properties: {
        'monitor-index': GObject.ParamSpec.uint(
            'monitor-index', 'monitor-index', 'monitor-index',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32, 0),
        'side': GObject.ParamSpec.enum(
            'side', 'side', 'side',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            St.Side, St.Side.LEFT),
        'slide-x': GObject.ParamSpec.double(
            'slide-x', 'slide-x', 'slide-x',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, 1, 1),
    }
}, class DashToDock_DashSlideContainer extends St.Bin {

    _init(params = {}) {
        super._init(params);

        this._slideoutSize = 0; // minimum size when slided out
        this.connect('notify::slide-x', () => this.queue_relayout());

        if (this.side == St.Side.TOP && DockManager.settings.get_boolean('dock-fixed')) {
            this._signalsHandler = new Utils.GlobalSignalsHandler(this);
            this._signalsHandler.add(Main.panel, 'notify::height',
                () => this.queue_relayout());
        }
    }

    vfunc_allocate(box) {
        let contentBox = this.get_theme_node().get_content_box(box);

        this.set_allocation(box);

        if (this.child == null)
            return;

        let availWidth = contentBox.x2 - contentBox.x1;
        let availHeight = contentBox.y2 - contentBox.y1;
        let [, , natChildWidth, natChildHeight] =
            this.child.get_preferred_size();

        let childWidth = natChildWidth;
        let childHeight = natChildHeight;

        let childBox = new Clutter.ActorBox();

        let slideoutSize = this._slideoutSize;

        if (this.side == St.Side.LEFT) {
            childBox.x1 = (this.slideX -1) * (childWidth - slideoutSize);
            childBox.x2 = slideoutSize + this.slideX * (childWidth - slideoutSize);
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        }
        else if ((this.side == St.Side.RIGHT) || (this.side == St.Side.BOTTOM)) {
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        }
        else if (this.side == St.Side.TOP) {
            const monitor = Main.layoutManager.monitors[this.monitorIndex];
            let yOffset = 0;
            if (Main.panel.x === monitor.x && Main.panel.y === monitor.y &&
                DockManager.settings.get_boolean('dock-fixed'))
                yOffset = Main.panel.height;
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = (this.slideX - 1) * (childHeight - slideoutSize) + yOffset;
            childBox.y2 = slideoutSize + this.slideX * (childHeight - slideoutSize) + yOffset;
            availHeight += yOffset;
        }

        this.child.allocate(childBox);

        this.child.set_clip(-childBox.x1, -childBox.y1,
                            -childBox.x1+availWidth, -childBox.y1 + availHeight);
    }

    /**
     * Just the child width but taking into account the slided out part
     */
    vfunc_get_preferred_width(forHeight) {
        let [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight);
        if ((this.side ==  St.Side.LEFT) || (this.side == St.Side.RIGHT)) {
            minWidth = (minWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
            natWidth = (natWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
        }
        return [minWidth, natWidth];
    }

    /**
     * Just the child height but taking into account the slided out part
     */
    vfunc_get_preferred_height(forWidth) {
        let [minHeight, natHeight] = super.vfunc_get_preferred_height(forWidth);
        if ((this.side ==  St.Side.TOP) || (this.side ==  St.Side.BOTTOM)) {
            minHeight = (minHeight - this._slideoutSize) * this.slideX + this._slideoutSize;
            natHeight = (natHeight - this._slideoutSize) * this.slideX + this._slideoutSize;

            if (this.side == St.Side.TOP && DockManager.settings.get_boolean('dock-fixed')) {
                const monitor = Main.layoutManager.monitors[this.monitorIndex];
                if (Main.panel.x === monitor.x && Main.panel.y === monitor.y) {
                    minHeight += Main.panel.height;
                    natHeight += Main.panel.height;
                }
            }
        }
        return [minHeight, natHeight];
    }
});

var DockedDash = GObject.registerClass({
    Signals: {
        'showing': {},
        'hiding': {},
    }
}, class DashToDock extends St.Bin {

    _init(remoteModel, monitorIndex) {
        this._rtl = (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL);

        // Load settings
        let settings = DockManager.settings;
        this._remoteModel = remoteModel;
        this._monitorIndex = monitorIndex;
        this._position = Utils.getPosition();
        this._isHorizontal = ((this._position == St.Side.TOP) || (this._position == St.Side.BOTTOM));

        // Temporary ignore hover events linked to autohide for whatever reason
        this._ignoreHover = false;
        this._oldignoreHover = null;
        // This variables are linked to the settings regardles of autohide or intellihide
        // being temporary disable. Get set by _updateVisibilityMode;
        this._autohideIsEnabled = null;
        this._intellihideIsEnabled = null;
        this._fixedIsEnabled = null;

        // Create intellihide object to monitor windows overlapping
        this._intellihide = new Intellihide.Intellihide(this._monitorIndex);

        // initialize dock state
        this._dockState = State.HIDDEN;

        // Put dock on the required monitor
        this._monitor = Main.layoutManager.monitors[this._monitorIndex];

        // this store size and the position where the dash is shown;
        // used by intellihide module to check window overlap.
        this.staticBox = new Clutter.ActorBox();

        // Initialize pressure barrier variables
        this._canUsePressure = false;
        this._pressureBarrier = null;
        this._barrier = null;
        this._removeBarrierTimeoutId = 0;

        // Initialize dwelling system variables
        this._dockDwelling = false;
        this._dockWatch = null;
        this._dockDwellUserTime = 0;
        this._dockDwellTimeoutId = 0

        // Create a new dash object
        this.dash = new MyDash.MyDash(this._remoteModel, this._monitorIndex);

        if (Main.overview.isDummy || !settings.get_boolean('show-show-apps-button'))
            this.dash.hideShowAppsButton();

        // Create the main actor and the containers for sliding in and out and
        // centering, turn on track hover

        let positionStyleClass = ['top', 'right', 'bottom', 'left'];
        // This is the centering actor
        super._init({
            name: 'dashtodockContainer',
            reactive: false,
            style_class: positionStyleClass[this._position],
        });

        // This is the sliding actor whose allocation is to be tracked for input regions
        this._slider = new DashSlideContainer({
            monitor_index: this._monitor.index,
            side: this._position,
            slide_x: 0,
            ...(this._isHorizontal ? {
                x_align: Clutter.ActorAlign.CENTER,
            } : {
                y_align: Clutter.ActorAlign.CENTER,
            })
        });

        // This is the actor whose hover status us tracked for autohide
        this._box = new St.BoxLayout({
            name: 'dashtodockBox',
            reactive: true,
            track_hover: true
        });
        this._box.connect('notify::hover', this._hoverChanged.bind(this));

        // Connect global signals
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._bindSettingsChanges();
        this._signalsHandler.add([
            // update when workarea changes, for instance if  other extensions modify the struts
            //(like moving th panel at the bottom)
            global.display,
            'workareas-changed',
            this._resetPosition.bind(this)
        ], [
            global.display,
            'in-fullscreen-changed',
            this._updateBarrier.bind(this)
        ], [
            // Monitor windows overlapping
            this._intellihide,
            'status-changed',
            this._updateDashVisibility.bind(this)
        ], [
            // sync hover after a popupmenu is closed
            this.dash,
            'menu-closed',
            () => { this._box.sync_hover() }
        ], [
            this.dash,
            'notify::requires-visibility',
            () => this._updateDashVisibility(),
        ]);

        if (!Main.overview.isDummy) {
            this._signalsHandler.add([
                Main.overview,
                'item-drag-begin',
                this._onDragStart.bind(this)
            ], [
                Main.overview,
                'item-drag-end',
                this._onDragEnd.bind(this)
            ], [
                Main.overview,
                'item-drag-cancelled',
                this._onDragEnd.bind(this)
            ], [
                Main.overview,
                'showing',
                this._onOverviewShowing.bind(this)
            ], [
                Main.overview,
                'hiding',
                this._onOverviewHiding.bind(this)
            ],
            [
                Main.overview,
                'hidden',
                this._onOverviewHidden.bind(this)
            ]);
        }

        this._themeManager = new Theming.ThemeManager(this);

        // Since the actor is not a topLevel child and its parent is now not added to the Chrome,
        // the allocation change of the parent container (slide in and slideout) doesn't trigger
        // anymore an update of the input regions. Force the update manually.
        this.connect('notify::allocation',
                     Main.layoutManager._queueUpdateRegions.bind(Main.layoutManager));


        // Since Clutter has no longer ClutterAllocationFlags,
        // "allocation-changed" signal has been removed. MR !1245
        this.dash._container.connect('notify::allocation', this._updateStaticBox.bind(this));
        this._slider.connect(this._isHorizontal ? 'notify::x' : 'notify::y', this._updateStaticBox.bind(this));

        // Load optional features that need to be activated for one dock only
        if (this._monitorIndex == settings.get_int('preferred-monitor'))
            this._enableExtraFeatures();
        // Load optional features that need to be activated once per dock
        this._optionalScrollWorkspaceSwitch();

         // Delay operations that require the shell to be fully loaded and with
         // user theme applied.

        this._paintId = global.stage.connect('after-paint', this._initialize.bind(this));

        // Add dash container actor and the container to the Chrome.
        this.set_child(this._slider);
        this._slider.set_child(this._box);
        this._box.add_actor(this.dash);

        // Add aligning container without tracking it for input region
        Main.uiGroup.add_child(this);
        if (Main.uiGroup.contains(global.top_window_group))
            Main.uiGroup.set_child_below_sibling(this, global.top_window_group);

        if (settings.get_boolean('dock-fixed')) {
            // Note: tracking the fullscreen directly on the slider actor causes some hiccups when fullscreening
            // windows of certain applications
            Main.layoutManager._trackActor(this, {affectsInputRegion: false, trackFullscreen: true});
            Main.layoutManager._trackActor(this._slider, {affectsStruts: true});
        }
        else
            Main.layoutManager._trackActor(this._slider);

        // Create and apply height/width constraint to the dash.
        if (this._isHorizontal) {
            this.connect('notify::width', () => {
                this.dash.setMaxSize(this.width, this.height);
            });
        } else {
            this.connect('notify::height', () => {
                this.dash.setMaxSize(this.width, this.height)
            });
        }

        if (this._position == St.Side.RIGHT)
            this.connect('notify::width', () => this.translation_x = -this.width);
        else if (this._position == St.Side.BOTTOM)
            this.connect('notify::height', () => this.translation_y = -this.height);

        // Set initial position
        this._resetPosition();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    get position() {
        return this._position;
    }

    get isHorizontal() {
        return this._isHorizontal;
    }

    _untrackDock() {
        Main.layoutManager._untrackActor(this);
        Main.layoutManager._untrackActor(this._slider);
    }

    _trackDock() {
        if (DockManager.settings.get_boolean('dock-fixed')) {
            if (Main.layoutManager._findActor(this) == -1)
                Main.layoutManager._trackActor(this, { affectsInputRegion: false, trackFullscreen: true });
            if (Main.layoutManager._findActor(this._slider) == -1)
                Main.layoutManager._trackActor(this._slider, { affectsStruts: true });
        } else {
            if (Main.layoutManager._findActor(this._slider) == -1)
                Main.layoutManager._trackActor(this._slider);
        }
    }

    _initialize() {
        if (this._paintId > 0) {
            global.stage.disconnect(this._paintId);
            this._paintId = 0;
        }

        // Apply custome css class according to the settings
        this._themeManager.updateCustomTheme();

        this._updateVisibilityMode();

        // In case we are already inside the overview when the extension is loaded,
        // for instance on unlocking the screen if it was locked with the overview open.
        if (Main.overview.visibleTarget) {
            this._onOverviewShowing();
        }

        // Setup pressure barrier (GS38+ only)
        this._updatePressureBarrier();
        this._updateBarrier();

        // setup dwelling system if pressure barriers are not available
        this._setupDockDwellIfNeeded();
    }

    _onDestroy() {
        // The dash, intellihide and themeManager have global signals as well internally
        this.dash.destroy();
        this._intellihide.destroy();
        this._themeManager.destroy();

        if (this._marginLater) {
            Meta.later_remove(this._marginLater);
            delete this._marginLater;
        }

        // Remove barrier timeout
        if (this._removeBarrierTimeoutId > 0)
            GLib.source_remove(this._removeBarrierTimeoutId);

        // Remove existing barrier
        this._removeBarrier();

        // Remove pointer watcher
        if (this._dockWatch) {
            PointerWatcher.getPointerWatcher()._removeWatch(this._dockWatch);
            this._dockWatch = null;
        }
    }

    _bindSettingsChanges() {
        let settings = DockManager.settings;
        this._signalsHandler.add([
            settings,
            'changed::scroll-action',
            () => { this._optionalScrollWorkspaceSwitch(); }
        ], [
            settings,
            'changed::dash-max-icon-size',
            () => { this.dash.setIconSize(settings.get_int('dash-max-icon-size')); }
        ], [
            settings,
            'changed::icon-size-fixed',
            () => { this.dash.setIconSize(settings.get_int('dash-max-icon-size')); }
        ], [
            settings,
            'changed::show-favorites',
            () => { this.dash.resetAppIcons(); }
        ], [
            settings,
            'changed::show-trash',
            () => { this.dash.resetAppIcons(); },
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::show-mounts',
            () => { this.dash.resetAppIcons(); },
            Utils.SignalsHandlerFlags.CONNECT_AFTER
        ], [
            settings,
            'changed::show-running',
            () => { this.dash.resetAppIcons(); }
        ], [
            settings,
            'changed::show-apps-at-top',
            () => { this.dash.updateShowAppsButton(); }
        ], [
            settings,
            'changed::show-show-apps-button',
            () => {
                    if (!Main.overview.isDummy &&
                        settings.get_boolean('show-show-apps-button'))
                        this.dash.showShowAppsButton();
                    else
                        this.dash.hideShowAppsButton();
            }
        ], [
            settings,
            'changed::dock-fixed',
            () => {
                this._untrackDock();
                this._trackDock();

                    this._resetPosition();

                    // Add or remove barrier depending on if dock-fixed
                    this._updateBarrier();

                    this._updateVisibilityMode();
            }
        ], [
            settings,
            'changed::intellihide',
            this._updateVisibilityMode.bind(this)
        ], [
            settings,
            'changed::intellihide-mode',
            () => { this._intellihide.forceUpdate(); }
        ], [
            settings,
            'changed::autohide',
            () => {
                    this._updateVisibilityMode();
                    this._updateBarrier();
            }
        ], [
            settings,
            'changed::autohide-in-fullscreen',
            this._updateBarrier.bind(this)
        ],
        [
            settings,
            'changed::extend-height',
            this._resetPosition.bind(this)
        ], [
            settings,
            'changed::height-fraction',
            this._resetPosition.bind(this)
        ], [
            settings,
            'changed::require-pressure-to-show',
            () => {
                    // Remove pointer watcher
                    if (this._dockWatch) {
                        PointerWatcher.getPointerWatcher()._removeWatch(this._dockWatch);
                        this._dockWatch = null;
                    }
                    this._setupDockDwellIfNeeded();
                    this._updateBarrier();
            }
        ], [
            settings,
            'changed::pressure-threshold',
            () => {
                    this._updatePressureBarrier();
                    this._updateBarrier();
            }
        ]);

    }

    /**
     * This is call when visibility settings change
     */
    _updateVisibilityMode() {
        let settings = DockManager.settings;
        if (settings.get_boolean('dock-fixed')) {
            this._fixedIsEnabled = true;
            this._autohideIsEnabled = false;
            this._intellihideIsEnabled = false;
        }
        else {
            this._fixedIsEnabled = false;
            this._autohideIsEnabled = settings.get_boolean('autohide')
            this._intellihideIsEnabled = settings.get_boolean('intellihide')
        }

        if (this._autohideIsEnabled)
            this.add_style_class_name('autohide');
        else
            this.remove_style_class_name('autohide');

        if (this._intellihideIsEnabled)
            this._intellihide.enable();
        else
            this._intellihide.disable();

        this._updateDashVisibility();
    }

    /**
     * Show/hide dash based on, in order of priority:
     * overview visibility
     * fixed mode
     * intellihide
     * autohide
     * overview visibility
     */
    _updateDashVisibility() {
        if (Main.overview.visibleTarget)
            return;

        let settings = DockManager.settings;

        if (this._fixedIsEnabled) {
            this._removeAnimations();
            this._animateIn(settings.get_double('animation-time'), 0);
        }
        else if (this._intellihideIsEnabled) {
            if (!this.dash.requiresVisibility && this._intellihide.getOverlapStatus()) {
                this._ignoreHover = false;
                // Do not hide if autohide is enabled and mouse is hover
                if (!this._box.hover || !this._autohideIsEnabled)
                    this._animateOut(settings.get_double('animation-time'), 0);
            }
            else {
                this._ignoreHover = true;
                this._removeAnimations();
                this._animateIn(settings.get_double('animation-time'), 0);
            }
        }
        else {
            if (this._autohideIsEnabled) {
                this._ignoreHover = false;

                if (this._box.hover || this.dash.requiresVisibility)
                    this._animateIn(settings.get_double('animation-time'), 0);
                else
                    this._animateOut(settings.get_double('animation-time'), 0);
            }
            else
                this._animateOut(settings.get_double('animation-time'), 0);
        }
    }

    _onOverviewShowing() {
        this.add_style_class_name('overview');

        this._ignoreHover = true;
        this._intellihide.disable();
        this._removeAnimations();
        this._animateIn(DockManager.settings.get_double('animation-time'), 0);
    }

    _onOverviewHiding() {
        this._ignoreHover = false;
        this._intellihide.enable();
        this._updateDashVisibility();
    }

    _onOverviewHidden() {
        this.remove_style_class_name('overview');
    }

    _hoverChanged() {
        if (!this._ignoreHover) {
            // Skip if dock is not in autohide mode for instance because it is shown
            // by intellihide.
            if (this._autohideIsEnabled) {
                if (this._box.hover)
                    this._show();
                else
                    this._hide();
            }
        }
    }

    getDockState() {
        return this._dockState;
    }

    _show() {
        this._delayedHide = false;
        if ((this._dockState == State.HIDDEN) || (this._dockState == State.HIDING)) {
            if (this._dockState == State.HIDING)
                // suppress all potential queued transitions - i.e. added but not started,
                // always give priority to show
                this._removeAnimations();

            this.emit('showing');
            this._animateIn(DockManager.settings.get_double('animation-time'), 0);
        }
    }

    _hide() {
        // If no hiding animation is running or queued
        if ((this._dockState == State.SHOWN) || (this._dockState == State.SHOWING)) {
            let settings = DockManager.settings;
            let delay = settings.get_double('hide-delay');

            if (this._dockState == State.SHOWING) {
                // if a show already started, let it finish; queue hide without removing the show.
                // to obtain this, we wait for the animateIn animation to be completed
                this._delayedHide = true;
                return;
            }

            this.emit('hiding');
            this._animateOut(settings.get_double('animation-time'), delay);
        }
    }

    _animateIn(time, delay) {
        this._dockState = State.SHOWING;
        this.dash.iconAnimator.start();
        this._delayedHide = false;

      this._slider.ease_property('slide-x', 1, {
            duration: time * 1000,
            delay: delay * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._dockState = State.SHOWN;
                // Remove barrier so that mouse pointer is released and can access monitors on other side of dock
                // NOTE: Delay needed to keep mouse from moving past dock and re-hiding dock immediately. This
                // gives users an opportunity to hover over the dock
                if (this._removeBarrierTimeoutId > 0)
                    GLib.source_remove(this._removeBarrierTimeoutId);

                if (!this._delayedHide) {
                    this._removeBarrierTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 100, this._removeBarrier.bind(this));
                } else {
                    this._hide();
                }
            }
        });
    }

    _animateOut(time, delay) {
        this._dockState = State.HIDING;

        this._slider.ease_property('slide-x', 0, {
            duration: time * 1000,
            delay: delay * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._dockState = State.HIDDEN;
                // Remove queued barried removal if any
                if (this._removeBarrierTimeoutId > 0)
                    GLib.source_remove(this._removeBarrierTimeoutId);
                this._updateBarrier();
                this.dash.iconAnimator.pause();
            }
        });
    }

    /**
     * Dwelling system based on the GNOME Shell 3.14 messageTray code.
     */
    _setupDockDwellIfNeeded() {
        // If we don't have extended barrier features, then we need
        // to support the old tray dwelling mechanism.
        if (!global.display.supports_extended_barriers() ||
            !DockManager.settings.get_boolean('require-pressure-to-show')) {
            let pointerWatcher = PointerWatcher.getPointerWatcher();
            this._dockWatch = pointerWatcher.addWatch(DOCK_DWELL_CHECK_INTERVAL, this._checkDockDwell.bind(this));
            this._dockDwelling = false;
            this._dockDwellUserTime = 0;
        }
    }

    _checkDockDwell(x, y) {

        let workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor.index)
        let shouldDwell;
        // Check for the correct screen edge, extending the sensitive area to the whole workarea,
        // minus 1 px to avoid conflicting with other active corners.
        if (this._position == St.Side.LEFT)
            shouldDwell = (x == this._monitor.x) && (y > workArea.y) && (y < workArea.y + workArea.height);
        else if (this._position == St.Side.RIGHT)
            shouldDwell = (x == this._monitor.x + this._monitor.width - 1) && (y > workArea.y) && (y < workArea.y + workArea.height);
        else if (this._position == St.Side.TOP)
            shouldDwell = (y == this._monitor.y) && (x > workArea.x) && (x < workArea.x + workArea.width);
        else if (this._position == St.Side.BOTTOM)
            shouldDwell = (y == this._monitor.y + this._monitor.height - 1) && (x > workArea.x) && (x < workArea.x + workArea.width);

        if (shouldDwell) {
            // We only set up dwell timeout when the user is not hovering over the dock
            // already (!this._box.hover).
            // The _dockDwelling variable is used so that we only try to
            // fire off one dock dwell - if it fails (because, say, the user has the mouse down),
            // we don't try again until the user moves the mouse up and down again.
            if (!this._dockDwelling && !this._box.hover && (this._dockDwellTimeoutId == 0)) {
                // Save the interaction timestamp so we can detect user input
                let focusWindow = global.display.focus_window;
                this._dockDwellUserTime = focusWindow ? focusWindow.user_time : 0;

                this._dockDwellTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    DockManager.settings.get_double('show-delay') * 1000,
                    this._dockDwellTimeout.bind(this));
                GLib.Source.set_name_by_id(this._dockDwellTimeoutId, '[dash-to-dock] this._dockDwellTimeout');
            }
            this._dockDwelling = true;
        }
        else {
            this._cancelDockDwell();
            this._dockDwelling = false;
        }
    }

    _cancelDockDwell() {
        if (this._dockDwellTimeoutId != 0) {
            GLib.source_remove(this._dockDwellTimeoutId);
            this._dockDwellTimeoutId = 0;
        }
    }

    _dockDwellTimeout() {
        this._dockDwellTimeoutId = 0;

        if (!DockManager.settings.get_boolean('autohide-in-fullscreen') &&
            this._monitor.inFullscreen)
            return GLib.SOURCE_REMOVE;

        // We don't want to open the tray when a modal dialog
        // is up, so we check the modal count for that. When we are in the
        // overview we have to take the overview's modal push into account
        if (Main.modalCount > (Main.overview.visible ? 1 : 0))
            return GLib.SOURCE_REMOVE;

        // If the user interacted with the focus window since we started the tray
        // dwell (by clicking or typing), don't activate the message tray
        let focusWindow = global.display.focus_window;
        let currentUserTime = focusWindow ? focusWindow.user_time : 0;
        if (currentUserTime != this._dockDwellUserTime)
            return GLib.SOURCE_REMOVE;

        // Reuse the pressure version function, the logic is the same
        this._onPressureSensed();
        return GLib.SOURCE_REMOVE;
    }

    _updatePressureBarrier() {
        let settings = DockManager.settings;
        this._canUsePressure = global.display.supports_extended_barriers();
        let pressureThreshold = settings.get_double('pressure-threshold');

        // Remove existing pressure barrier
        if (this._pressureBarrier) {
            this._pressureBarrier.destroy();
            this._pressureBarrier = null;
        }

        if (this._barrier) {
            this._barrier.destroy();
            this._barrier = null;
        }

        // Create new pressure barrier based on pressure threshold setting
        if (this._canUsePressure) {
            this._pressureBarrier = new Layout.PressureBarrier(pressureThreshold, settings.get_double('show-delay')*1000,
                                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            this._pressureBarrier.connect('trigger', (barrier) => {
                if (!settings.get_boolean('autohide-in-fullscreen') && this._monitor.inFullscreen)
                    return;
                this._onPressureSensed();
            });
        }
    }

    /**
     * handler for mouse pressure sensed
     */
    _onPressureSensed() {
        if (Main.overview.visibleTarget)
            return;

        // In case the mouse move away from the dock area before hovering it, in such case the leave event
        // would never be triggered and the dock would stay visible forever.
        let triggerTimeoutId =  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            triggerTimeoutId = 0;

            let [x, y, mods] = global.get_pointer();
            let shouldHide = true;
            switch (this._position) {
            case St.Side.LEFT:
                if (x <= this.staticBox.x2 &&
                    x >= this._monitor.x &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height) {
                    shouldHide = false;
                }
                break;
            case St.Side.RIGHT:
                if (x >= this.staticBox.x1 &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height) {
                    shouldHide = false;
                }
                break;
            case St.Side.TOP:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y <= this.staticBox.y2 &&
                    y >= this._monitor.y) {
                    shouldHide = false;
                }
                break;
            case St.Side.BOTTOM:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this.staticBox.y1 &&
                    y <= this._monitor.y + this._monitor.height) {
                    shouldHide = false;
                }
            }
            if (shouldHide) {
                this._hoverChanged();
                return GLib.SOURCE_REMOVE;
            }
            else {
                return GLib.SOURCE_CONTINUE;
            }

        });

        this._show();
    }

    /**
     * Remove pressure barrier
     */
    _removeBarrier() {
        if (this._barrier) {
            if (this._pressureBarrier)
                this._pressureBarrier.removeBarrier(this._barrier);
            this._barrier.destroy();
            this._barrier = null;
        }
        this._removeBarrierTimeoutId = 0;
        return false;
    }

    /**
     * Update pressure barrier size
     */
    _updateBarrier() {
        // Remove existing barrier
        this._removeBarrier();

        // The barrier needs to be removed in fullscreen with autohide disabled, otherwise the mouse can
        // get trapped on monitor.
        if (this._monitor.inFullscreen &&
            !DockManager.settings.get_boolean('autohide-in-fullscreen'))
            return

        // Manually reset pressure barrier
        // This is necessary because we remove the pressure barrier when it is triggered to show the dock
        if (this._pressureBarrier) {
            this._pressureBarrier._reset();
            this._pressureBarrier._isTriggered = false;
        }

        // Create new barrier
        // The barrier extends to the whole workarea, minus 1 px to avoid conflicting with other active corners
        // Note: dash in fixed position doesn't use pressure barrier.
        if (this._canUsePressure && this._autohideIsEnabled &&
            DockManager.settings.get_boolean('require-pressure-to-show')) {
            let x1, x2, y1, y2, direction;
            let workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor.index)

            if (this._position == St.Side.LEFT) {
                x1 = this._monitor.x + 1;
                x2 = x1;
                y1 = workArea.y + 1;
                y2 = workArea.y + workArea.height - 1;
                direction = Meta.BarrierDirection.POSITIVE_X;
            }
            else if (this._position == St.Side.RIGHT) {
                x1 = this._monitor.x + this._monitor.width - 1;
                x2 = x1;
                y1 = workArea.y + 1;
                y2 = workArea.y + workArea.height - 1;
                direction = Meta.BarrierDirection.NEGATIVE_X;
            }
            else if (this._position == St.Side.TOP) {
                x1 = workArea.x + 1;
                x2 = workArea.x + workArea.width - 1;
                y1 = this._monitor.y;
                y2 = y1;
                direction = Meta.BarrierDirection.POSITIVE_Y;
            }
            else if (this._position == St.Side.BOTTOM) {
                x1 = workArea.x + 1;
                x2 = workArea.x + workArea.width - 1;
                y1 = this._monitor.y + this._monitor.height;
                y2 = y1;
                direction = Meta.BarrierDirection.NEGATIVE_Y;
            }

            if (this._pressureBarrier && this._dockState == State.HIDDEN) {
                this._barrier = new Meta.Barrier({
                    display: global.display,
                    x1: x1,
                    x2: x2,
                    y1: y1,
                    y2: y2,
                    directions: direction
                });
                this._pressureBarrier.addBarrier(this._barrier);
            }
        }
    }

    _isPrimaryMonitor() {
        return (this._monitorIndex == Main.layoutManager.primaryIndex);
    }

    _resetPosition() {
        // Ensure variables linked to settings are updated.
        this._updateVisibilityMode();

        let extendHeight = DockManager.settings.get_boolean('extend-height');
        const fixedIsEnabled = DockManager.settings.get_boolean('dock-fixed');

        if (fixedIsEnabled) {
            this.add_style_class_name('fixed');
        } else {
            this.remove_style_class_name('fixed');
        }

        // Note: do not use the workarea coordinates in the direction on which the dock is placed,
        // to avoid a loop [position change -> workArea change -> position change] with
        // fixed dock.
        let workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);


        let fraction = DockManager.settings.get_double('height-fraction');

        if (extendHeight)
            fraction = 1;
        else if ((fraction < 0) || (fraction > 1))
            fraction = 0.95;

        if (this._isHorizontal) {
            this.width = Math.round(fraction * workArea.width);

            let pos_y = this._monitor.y;
            if (this._position == St.Side.BOTTOM)
                pos_y += this._monitor.height;

            this.x = workArea.x + Math.round((1 - fraction) / 2 * workArea.width);
            this.y = pos_y;

            if (extendHeight) {
                this.dash._container.set_width(this.width);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_width(-1);
                this.remove_style_class_name('extended');
            }
        } else {
            this.height = Math.round(fraction * workArea.height);

            let pos_x = this._monitor.x;
            if (this._position == St.Side.RIGHT)
                pos_x += this._monitor.width;

            this.x = pos_x;
            this.y = workArea.y + Math.round((1 - fraction) / 2 * workArea.height);

            this._signalsHandler.removeWithLabel('verticalOffsetChecker');

            if (extendHeight) {
                this.dash._container.set_height(this.height);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_height(-1);
                this.remove_style_class_name('extended');
            }
        }
    }

    _updateStaticBox() {
        this.staticBox.init_rect(
            this.x + this._slider.x - (this._position == St.Side.RIGHT ? this._box.width : 0),
            this.y + this._slider.y - (this._position == St.Side.BOTTOM ? this._box.height : 0),
            this._box.width,
            this._box.height
        );

        this._intellihide.updateTargetBox(this.staticBox);
    }

    _removeAnimations() {
        this._slider.remove_all_transitions();
    }

    _onDragStart() {
        this._oldignoreHover = this._ignoreHover;
        this._ignoreHover = true;
        this._animateIn(DockManager.settings.get_double('animation-time'), 0);
    }

    _onDragEnd() {
        if (this._oldignoreHover !== null)
            this._ignoreHover  = this._oldignoreHover;
        this._oldignoreHover = null;
        this._box.sync_hover();
    }

    /**
     * Show dock and give key focus to it
     */
    _onAccessibilityFocus() {
        this._box.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        this._animateIn(DockManager.settings.get_double('animation-time'), 0);
    }

    // Optional features to be enabled only for the main Dock
    _enableExtraFeatures() {
        // Restore dash accessibility
        Main.ctrlAltTabManager.addGroup(
            this.dash, _('Dash'), 'user-bookmarks-symbolic',
                {focusCallback: this._onAccessibilityFocus.bind(this)});
    }

    /**
     * Switch workspace by scrolling over the dock
     */
    _optionalScrollWorkspaceSwitch() {
        let label = 'optionalScrollWorkspaceSwitch';

        function isEnabled() {
            return DockManager.settings.get_enum('scroll-action') === scrollAction.SWITCH_WORKSPACE;
        }

        DockManager.settings.connect('changed::scroll-action', () => {
            if (isEnabled.bind(this)())
                enable.bind(this)();
            else
                disable.bind(this)();
        });

        if (isEnabled.bind(this)())
            enable.bind(this)();

        function enable() {
            this._signalsHandler.removeWithLabel(label);

            this._signalsHandler.addWithLabel(label,
                this._box,
                'scroll-event',
                onScrollEvent.bind(this));
        }

        function disable() {
            this._signalsHandler.removeWithLabel(label);

            if (this._optionalScrollWorkspaceSwitchDeadTimeId) {
                GLib.source_remove(this._optionalScrollWorkspaceSwitchDeadTimeId);
                this._optionalScrollWorkspaceSwitchDeadTimeId = 0;
            }
        }

        // This was inspired to desktop-scroller@obsidien.github.com
        function onScrollEvent(actor, event) {
            // When in overview change workspace only in windows view
            if (Main.overview.visible)
                return false;

            let activeWs = global.workspace_manager.get_active_workspace();
            let direction = null;

            let prev_direction, next_direction;
            if (global.workspace_manager.layout_columns > global.workspace_manager.layout_rows) {
                prev_direction = Meta.MotionDirection.UP;
                next_direction = Meta.MotionDirection.DOWN;
            } else {
                prev_direction = Meta.MotionDirection.LEFT;
                next_direction = Meta.MotionDirection.RIGHT;
            }

            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                direction = prev_direction;
                break;
            case Clutter.ScrollDirection.DOWN:
                direction = next_direction;
                break;
            case Clutter.ScrollDirection.SMOOTH:
                let [dx, dy] = event.get_scroll_delta();
                if (dy < 0)
                    direction = prev_direction;
                else if (dy > 0)
                    direction = next_direction;
                break;
            }

            if (direction !== null) {
                // Prevent scroll events from triggering too many workspace switches
                // by adding a 250ms deadtime between each scroll event.
                // Usefull on laptops when using a touchpad.

                // During the deadtime do nothing
                if (this._optionalScrollWorkspaceSwitchDeadTimeId)
                    return false;
                else
                    this._optionalScrollWorkspaceSwitchDeadTimeId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 250, () => {
                        this._optionalScrollWorkspaceSwitchDeadTimeId = 0;
                    });

                let ws;

                ws = activeWs.get_neighbor(direction)

                if (Main.wm._workspaceSwitcherPopup == null)
                    // Support Workspace Grid extension showing their custom Grid Workspace Switcher
                    if (global.workspace_manager.workspace_grid !== undefined) {
                        Main.wm._workspaceSwitcherPopup =
                            global.workspace_manager.workspace_grid.getWorkspaceSwitcherPopup();
                    } else {
                        Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                    }
                    // Set the actor non reactive, so that it doesn't prevent the
                    // clicks events from reaching the dash actor. I can't see a reason
                    // why it should be reactive.
                    Main.wm._workspaceSwitcherPopup.reactive = false;
                    Main.wm._workspaceSwitcherPopup.connect('destroy', function() {
                        Main.wm._workspaceSwitcherPopup = null;
                    });

                // If Workspace Grid is installed, let them handle the scroll behaviour.
                if (global.workspace_manager.workspace_grid !== undefined)
                    ws = global.workspace_manager.workspace_grid.actionMoveWorkspace(direction);
                else
                    Main.wm.actionMoveWorkspace(ws);

                // Do not show workspaceSwitcher in overview
                if (!Main.overview.visible)
                    Main.wm._workspaceSwitcherPopup.display(direction, ws.index());

                return true;
            }
            else
                return false;
        }
    }

    _activateApp(appIndex) {
        let children = this.dash._box.get_children().filter(function(actor) {
                return actor.child &&
                       actor.child.app;
        });

        // Apps currently in the dash
        let apps = children.map(function(actor) {
                return actor.child;
            });

        // Activate with button = 1, i.e. same as left click
        let button = 1;
        if (appIndex < apps.length)
            apps[appIndex].activate(button);
    }
});

/*
 * Handle keybaord shortcuts
 */
const DashToDock_KeyboardShortcuts_NUM_HOTKEYS = 10;

var KeyboardShortcuts = class DashToDock_KeyboardShortcuts {

    constructor() {
        this._signalsHandler = new Utils.GlobalSignalsHandler();

        this._hotKeysEnabled = false;
        if (DockManager.settings.get_boolean('hot-keys'))
            this._enableHotKeys();

        this._signalsHandler.add([
            DockManager.settings,
            'changed::hot-keys',
            () => {
                    if (DockManager.settings.get_boolean('hot-keys'))
                        this._enableHotKeys.bind(this)();
                    else
                        this._disableHotKeys.bind(this)();
            }
        ]);

        this._optionalNumberOverlay();
    }

    destroy() {
        // Remove keybindings
        this._disableHotKeys();
        this._disableExtraShortcut();
        this._signalsHandler.destroy();
    }

    _enableHotKeys() {
        if (this._hotKeysEnabled)
            return;

        // Setup keyboard bindings for dash elements
        let keys = ['app-hotkey-', 'app-shift-hotkey-', 'app-ctrl-hotkey-'];
        keys.forEach( function(key) {
            for (let i = 0; i < DashToDock_KeyboardShortcuts_NUM_HOTKEYS; i++) {
                let appNum = i;
                Main.wm.addKeybinding(key + (i + 1), DockManager.settings,
                                      Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                                      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                                      () => {
                                          DockManager.getDefault().mainDock._activateApp(appNum);
                                          this._showOverlay();
                                      });
            }
        }, this);

        this._hotKeysEnabled = true;
    }

    _disableHotKeys() {
        if (!this._hotKeysEnabled)
            return;

        let keys = ['app-hotkey-', 'app-shift-hotkey-', 'app-ctrl-hotkey-'];
        keys.forEach( function(key) {
            for (let i = 0; i < DashToDock_KeyboardShortcuts_NUM_HOTKEYS; i++)
                Main.wm.removeKeybinding(key + (i + 1));
        }, this);

        this._hotKeysEnabled = false;
    }

    _optionalNumberOverlay() {
        let settings = DockManager.settings;
        this._shortcutIsSet = false;
        // Enable extra shortcut if either 'overlay' or 'show-dock' are true
        if (settings.get_boolean('hot-keys') &&
           (settings.get_boolean('hotkeys-overlay') || settings.get_boolean('hotkeys-show-dock')))
            this._enableExtraShortcut();

        this._signalsHandler.add([
            settings,
            'changed::hot-keys',
            this._checkHotkeysOptions.bind(this)
        ], [
            settings,
            'changed::hotkeys-overlay',
            this._checkHotkeysOptions.bind(this)
        ], [
            settings,
            'changed::hotkeys-show-dock',
            this._checkHotkeysOptions.bind(this)
        ]);
    }

    _checkHotkeysOptions() {
        let settings = DockManager.settings;

        if (settings.get_boolean('hot-keys') &&
           (settings.get_boolean('hotkeys-overlay') || settings.get_boolean('hotkeys-show-dock')))
            this._enableExtraShortcut();
        else
            this._disableExtraShortcut();
    }

    _enableExtraShortcut() {
        if (!this._shortcutIsSet) {
            Main.wm.addKeybinding('shortcut', DockManager.settings,
                                  Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                                  Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                                  this._showOverlay.bind(this));
            this._shortcutIsSet = true;
        }
    }

    _disableExtraShortcut() {
        if (this._shortcutIsSet) {
            Main.wm.removeKeybinding('shortcut');
            this._shortcutIsSet = false;
        }
    }

    _showOverlay() {
        for (let dock of DockManager.allDocks) {
            if (DockManager.settings.get_boolean('hotkeys-overlay'))
                dock.dash.toggleNumberOverlay(true);

            // Restart the counting if the shortcut is pressed again
            if (dock._numberOverlayTimeoutId) {
                GLib.source_remove(dock._numberOverlayTimeoutId);
                dock._numberOverlayTimeoutId = 0;
            }

            // Hide the overlay/dock after the timeout
            let timeout = DockManager.settings.get_double('shortcut-timeout') * 1000;
            dock._numberOverlayTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, timeout, () => {
                    dock._numberOverlayTimeoutId = 0;
                    dock.dash.toggleNumberOverlay(false);
                    // Hide the dock again if necessary
                    dock._updateDashVisibility();
            });

            // Show the dock if it is hidden
            if (DockManager.settings.get_boolean('hotkeys-show-dock')) {
                let showDock = (dock._intellihideIsEnabled || dock._autohideIsEnabled);
                if (showDock)
                    dock._show();
            }
        }
    }
};

/**
 * Isolate overview to open new windows for inactive apps
 * Note: the future implementaion is not fully contained here. Some bits are around in other methods of other classes.
 * This class just take care of enabling/disabling the option.
 */
var WorkspaceIsolation = class DashToDock_WorkspaceIsolation {

    constructor() {

        let settings = DockManager.settings;

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._injectionsHandler = new Utils.InjectionsHandler();

        this._signalsHandler.add([
            settings,
            'changed::isolate-workspaces',
            () => {
                    DockManager.allDocks.forEach((dock) =>
                        dock.dash.resetAppIcons());
                    if (settings.get_boolean('isolate-workspaces') ||
                        settings.get_boolean('isolate-monitors'))
                        this._enable.bind(this)();
                    else
                        this._disable.bind(this)();
            }
        ],[
            settings,
            'changed::isolate-monitors',
            () => {
                    DockManager.allDocks.forEach((dock) =>
                        dock.dash.resetAppIcons());
                    if (settings.get_boolean('isolate-workspaces') ||
                        settings.get_boolean('isolate-monitors'))
                        this._enable.bind(this)();
                    else
                        this._disable.bind(this)();
            }
        ]);

        if (settings.get_boolean('isolate-workspaces') ||
            settings.get_boolean('isolate-monitors'))
            this._enable();

    }

    _enable() {

        // ensure I never double-register/inject
        // although it should never happen
        this._disable();

        DockManager.allDocks.forEach((dock) => {
            this._signalsHandler.addWithLabel('isolation', [
                global.display,
                'restacked',
                dock.dash._queueRedisplay.bind(dock.dash)
            ], [
                global.window_manager,
                'switch-workspace',
                dock.dash._queueRedisplay.bind(dock.dash)
            ]);

            // This last signal is only needed for monitor isolation, as windows
            // might migrate from one monitor to another without triggering 'restacked'
            if (DockManager.settings.get_boolean('isolate-monitors'))
                this._signalsHandler.addWithLabel('isolation',
                    global.display,
                    'window-entered-monitor',
                    dock.dash._queueRedisplay.bind(dock.dash));
        }, this);

        // here this is the Shell.App
        function IsolatedOverview() {
            // These lines take care of Nautilus for icons on Desktop
            let windows = this.get_windows().filter(function(w) {
                return w.get_workspace().index() == global.workspace_manager.get_active_workspace_index();
            });
            if (windows.length == 1)
                if (windows[0].skip_taskbar)
                    return this.open_new_window(-1);

            if (this.is_on_workspace(global.workspace_manager.get_active_workspace()))
                return Main.activateWindow(windows[0]);
            return this.open_new_window(-1);
        }

        this._injectionsHandler.addWithLabel('isolation',
            Shell.App.prototype,
            'activate',
            IsolatedOverview);
    }

    _disable () {
        this._signalsHandler.removeWithLabel('isolation');
        this._injectionsHandler.removeWithLabel('isolation');
    }

    destroy() {
        this._signalsHandler.destroy();
        this._injectionsHandler.destroy();
    }
};


var DockManager = class DashToDock_DockManager {

    constructor() {
        if (Me.imports.extension.dockManager)
            throw new Error('DashToDock has been already initialized');

        Me.imports.extension.dockManager = this;

        this._remoteModel = new LauncherAPI.LauncherEntryRemoteModel();
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._methodInjections = new Utils.InjectionsHandler(this);
        this._vfuncInjections = new Utils.VFuncInjectionsHandler(this);
        this._propertyInjections = new Utils.PropertyInjectionsHandler(this);
        this._settings = ExtensionUtils.getSettings('org.gnome.shell.extensions.dash-to-dock');
        this._oldDash = Main.overview.isDummy ? null : Main.overview.dash;

        this._ensureFileManagerClient();

        /* Array of all the docks created */
        this._allDocks = [];
        this._createDocks();

        // status variable: true when the overview is shown through the dash
        // applications button.
        this._forcedOverview = false;

        // Connect relevant signals to the toggling function
        this._bindSettingsChanges();
    }

    static getDefault() {
        return Me.imports.extension.dockManager
    }

    static get allDocks() {
        return DockManager.getDefault()._allDocks;
    }

    static get settings() {
        return DockManager.getDefault()._settings;
    }

    get fm1Client() {
        return this._fm1Client;
    }

    get mainDock() {
        return this._allDocks.length ? this._allDocks[0] : null;
    }

    getDockByMonitor(monitorIndex) {
        return this._allDocks.find(d => (d.monitorIndex === monitorIndex));
    }

    _ensureFileManagerClient() {
        let supportsLocations = ['show-trash', 'show-mounts'].some((s) => {
            return this._settings.get_boolean(s);
        });

        if (supportsLocations) {
            if (!this._fm1Client)
                this._fm1Client = new FileManager1API.FileManager1Client();
        } else if (this._fm1Client) {
            this._fm1Client.destroy();
            this._fm1Client = null;
        }
    }

    _toggle() {
        if (this._toggleLater)
            Meta.later_remove(this._toggleLater);

        this._toggleLater = Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
            delete this._toggleLater;
            this._restoreDash();
            this._deleteDocks();
            this._createDocks();
            this.emit('toggled');
        });
    }

    _bindSettingsChanges() {
        // Connect relevant signals to the toggling function
        this._signalsHandler.add([
            Meta.MonitorManager.get(),
            'monitors-changed',
            this._toggle.bind(this)
        ], [
            Main.sessionMode,
            'updated',
            this._toggle.bind(this)
        ], [
            this._settings,
            'changed::multi-monitor',
            this._toggle.bind(this)
        ], [
            this._settings,
            'changed::preferred-monitor',
            this._toggle.bind(this)
        ], [
            this._settings,
            'changed::dock-position',
            this._toggle.bind(this)
        ], [
            this._settings,
            'changed::extend-height',
            this._adjustPanelCorners.bind(this)
        ], [
            this._settings,
            'changed::dock-fixed',
            this._adjustPanelCorners.bind(this)
        ], [
            this._settings,
            'changed::show-trash',
            () => this._ensureFileManagerClient()
        ], [
            this._settings,
            'changed::show-mounts',
            () => this._ensureFileManagerClient()
        ]);
    }

    _createDocks() {

        // If there are no monitors (headless configurations, but it can also happen temporary while disconnecting
        // and reconnecting monitors), just do nothing. When a monitor will be connected we we'll be notified and
        // and thus create the docks. This prevents pointing trying to access monitors throughout the code, were we
        // are assuming that at least the primary monitor is present.
        if (Main.layoutManager.monitors.length <= 0) {
            return;
        }

        this._preferredMonitorIndex = this._settings.get_int('preferred-monitor');
        // In case of multi-monitor, we consider the dock on the primary monitor to be the preferred (main) one
        // regardless of the settings
        // The dock goes on the primary monitor also if the settings are incosistent (e.g. desired monitor not connected).
        if (this._settings.get_boolean('multi-monitor') ||
            this._preferredMonitorIndex < 0 || this._preferredMonitorIndex > Main.layoutManager.monitors.length - 1
            ) {
            this._preferredMonitorIndex = Main.layoutManager.primaryIndex;
        } else {
            // Primary monitor used to be always 0 in Gdk, but the shell has a different
            // concept (where the order depends on mutter order).
            // So even if now the extension settings may use the same logic of the shell
            // we prefer not to break the previously configured systems, and so we still
            // assume that the gsettings monitor numbering follows the old strategy.
            // This ensure the indexing in the settings and in the shell are matched,
            // i.e. that we start counting from the primaryMonitorIndex
            this._preferredMonitorIndex = (Main.layoutManager.primaryIndex + this._preferredMonitorIndex) % Main.layoutManager.monitors.length ;
        }

        // First we create the main Dock, to get the extra features to bind to this one
        let dock = new DockedDash(this._remoteModel, this._preferredMonitorIndex);
        this._allDocks.push(dock);

        // connect app icon into the view selector
        dock.dash.showAppsButton.connect('notify::checked', this._onShowAppsButtonToggled.bind(this));

        // Make the necessary changes to Main.overview.dash
        this._prepareMainDash();

        // Adjust corners if necessary
        this._adjustPanelCorners();

        if (this._settings.get_boolean('multi-monitor')) {
            let nMon = Main.layoutManager.monitors.length;
            for (let iMon = 0; iMon < nMon; iMon++) {
                if (iMon == this._preferredMonitorIndex)
                    continue;
                let dock = new DockedDash(this._remoteModel, iMon);
                this._allDocks.push(dock);
                // connect app icon into the view selector
                dock.dash.showAppsButton.connect('notify::checked', this._onShowAppsButtonToggled.bind(this));
            }
        }

        // Load optional features. We load *after* the docks are created, since
        // we need to connect the signals to all dock instances.
        this._workspaceIsolation = new WorkspaceIsolation();
        this._keyboardShortcuts = new KeyboardShortcuts();

        this.emit('docks-ready');
    }

    _prepareMainDash() {
        // Ensure Main.overview.dash is set to our dash in dummy mode
        // while just use the default getter otherwise.
        // The getter must be dynamic and not set only when we've a dummy
        // overview because the mode can change dynamically.
        this._propertyInjections.removeWithLabel('main-dash');
        let defaultDashGetter = Object.getOwnPropertyDescriptor(
            Main.overview.constructor.prototype, 'dash').get;
        this._propertyInjections.addWithLabel('main-dash', Main.overview, 'dash', {
            get: () => Main.overview.isDummy ?
                this.mainDock.dash : defaultDashGetter.call(Main.overview),
        });

        if (Main.overview.isDummy)
            return;

        // Hide usual Dash
        this._oldDash.hide();

        // Also set dash width to 1, so it's almost not taken into account by code
        // calculaing the reserved space in the overview. The reason to keep it at 1 is
        // to allow its visibility change to trigger an allocaion of the appGrid which
        // in turn is triggergin the appsIcon spring animation, required when no other
        // actors has this effect, i.e in horizontal mode and without the workspaceThumnails
        // 1 static workspace only)
        this._oldDash.set_height(1);

        this._signalsHandler.addWithLabel('old-dash-changes', [
            this._oldDash,
            'notify::visible',
            () => this._oldDash.hide()
        ], [
            this._oldDash,
            'notify::height',
            () => this._oldDash.set_height(1)
        ]);

        // Pretend I'm the dash: meant to make appgrid swarm animation come from
        // the right position of the appShowButton.
        let overviewControls = Main.overview._overview._controls;
        overviewControls.dash = this.mainDock.dash;
        overviewControls._searchController._showAppsButton = this.mainDock.dash.showAppsButton;

        // We also need to ignore max-size changes
        this._methodInjections.addWithLabel('main-dash', this._oldDash,
            'setMaxSize', () => {});
        this._methodInjections.addWithLabel('main-dash', this._oldDash,
            'allocate', () => {});
        // And to return the preferred height depending on the state
        this._methodInjections.addWithLabel('main-dash', this._oldDash,
            'get_preferred_height', (_originalMethod, ...args) => {
                if (this.mainDock.isHorizontal && !this._settings.get_boolean('dock-fixed'))
                    return this.mainDock.get_preferred_height(...args);
                return [0, 0];
            });

        const { ControlsManager, ControlsManagerLayout } = OverviewControls;

        this._methodInjections.addWithLabel('main-dash', ControlsManager.prototype,
            'runStartupAnimation', async function (originalMethod, callback) {
                const injections = new Utils.InjectionsHandler();
                DockManager.allDocks.forEach(dock => (dock.opacity = 0));
                injections.add(DockManager.getDefault().mainDock.dash, 'ease', () => {});
                let callbackArgs = [];
                const ret = await originalMethod.call(this,
                    (...args) => (callbackArgs = [...args]));
                injections.destroy();

                if (!DockManager.allDocks.length) {
                    // Docks may have been destroyed, let's wait till we've one again
                    const readyPromise = new Promise(resolve => {
                        const id = DockManager.getDefault().connect('docks-ready', () => {
                            DockManager.getDefault().disconnect(id);
                            resolve();
                        });
                    })
                    await readyPromise;
                }

                DockManager.allDocks.forEach(dock => {
                    const { dash } = dock;

                    dash.set({
                        opacity: 0,
                        translation_x: 0,
                        translation_y: 0,
                    });
                    dock.opacity = 255;

                    switch (dock.position) {
                        case St.Side.LEFT:
                            dash.translation_x = -dash.width;
                            break;
                        case St.Side.RIGHT:
                            dash.translation_x = dash.width;
                            break;
                        case St.Side.BOTTOM:
                            dash.translation_y = dash.height;
                            break;
                        case St.Side.TOP:
                            dash.translation_y = -dash.height;
                            break;
                    }

                    const mainDockProperties = {};
                    if (dock === DockManager.getDefault().mainDock)
                        mainDockProperties.onComplete = callback(...callbackArgs);

                    const { STARTUP_ANIMATION_TIME } = Layout;
                    dash.ease({
                        opacity: 255,
                        translation_x: 0,
                        translation_y: 0,
                        delay: STARTUP_ANIMATION_TIME,
                        duration: STARTUP_ANIMATION_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        ...mainDockProperties,
                    });
                });
                return ret;
            });

        this._vfuncInjections.addWithLabel('main-dash', ControlsManagerLayout.prototype,
            'allocate', function (container) {
                const oldPostAllocation = this._runPostAllocation;
                this._runPostAllocation = () => {};

                const monitor = Main.layoutManager.findMonitorForActor(this._container);
                const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
                const startX = workArea.x - monitor.x;
                const startY = workArea.y - monitor.y;
                const workAreaBox = new Clutter.ActorBox();
                workAreaBox.set_origin(startX, startY);
                workAreaBox.set_size(workArea.width, workArea.height);

                const propertyInjections = new Utils.PropertyInjectionsHandler();
                propertyInjections.add(Main.layoutManager.panelBox, 'height', { value: workAreaBox.y1 });

                if (Main.layoutManager.panelBox.y === Main.layoutManager.primaryMonitor.y)
                    workAreaBox.y1 -= startY;

                this.vfunc_allocate(container, workAreaBox);

                propertyInjections.destroy();
                workAreaBox.y1 = startY;

                const adjustActorHorizontalAllocation = actor => {
                    if (!actor.visible || !workAreaBox.x1)
                        return;

                    const contentBox = actor.get_allocation_box();
                    contentBox.set_size(workAreaBox.get_width(), contentBox.get_height());
                    contentBox.set_origin(workAreaBox.x1, contentBox.y1);
                    actor.allocate(contentBox);
                };

                [this._searchEntry, this._workspacesThumbnails, this._searchController].forEach(
                    actor => adjustActorHorizontalAllocation(actor));

                this._runPostAllocation = oldPostAllocation;
                this._runPostAllocation();
            });

        // This can be removed or bypassed when GNOME/gnome-shell!1892 will be merged
        function workspaceBoxOriginFixer(originalFunction, state, workAreaBox, ...args) {
            const workspaceBox = originalFunction.call(this, state, workAreaBox, ...args);
            workspaceBox.set_origin(workAreaBox.x1, workspaceBox.y1);
            return workspaceBox;
        };

        this._methodInjections.addWithLabel('main-dash', [
            ControlsManagerLayout.prototype,
            '_computeWorkspacesBoxForState',
            workspaceBoxOriginFixer
        ], [
            ControlsManagerLayout.prototype,
            '_getAppDisplayBoxForState',
            workspaceBoxOriginFixer
        ]);

        this._vfuncInjections.addWithLabel('main-dash', Workspace.WorkspaceBackground.prototype,
            'allocate', function (box) {
            this.vfunc_allocate(box);

            // This code has been submitted upstream via GNOME/gnome-shell!1892
            // so can be removed when that gets merged (or bypassed on newer shell
            // versions).
            const monitor = Main.layoutManager.monitors[this._monitorIndex];
            const [contentWidth, contentHeight] = this._bin.get_content_box().get_size();
            const [mX1, mX2] = [monitor.x, monitor.x + monitor.width];
            const [mY1, mY2] = [monitor.y, monitor.y + monitor.height];
            const [wX1, wX2] = [this._workarea.x, this._workarea.x + this._workarea.width];
            const [wY1, wY2] = [this._workarea.y, this._workarea.y + this._workarea.height];
            const xScale = contentWidth / this._workarea.width;
            const yScale = contentHeight / this._workarea.height;
            const leftOffset = wX1 - mX1;
            const topOffset = wY1 - mY1;
            const rightOffset = mX2 - wX2;
            const bottomOffset = mY2 - wY2;

            const contentBox = new Clutter.ActorBox();
            contentBox.set_origin(-leftOffset * xScale, -topOffset * yScale);
            contentBox.set_size(
                contentWidth + (leftOffset + rightOffset) * xScale,
                contentHeight + (topOffset + bottomOffset) * yScale);

            this._backgroundGroup.allocate(contentBox);
        });

        // Always show the thumbnails box in fixed mode, so that we'll reduce the
        // vertical space, causing the Workspace layout to show more workspaces.
        // We might get the same also reducing the height of the workspace boxes
        // in _computeWorkspacesBoxForState, but it would just waste vertical space
        if (!this.mainDock.isHorizontal || this._settings.get_boolean('dock-fixed')) {
            this._methodInjections.addWithLabel('main-dash',
                WorkspaceThumbnail.ThumbnailsBox.prototype, '_updateShouldShow',
                function () {
                    const shouldShow = global.workspace_manager.nWorkspaces > 1;
                    if (this._shouldShow === shouldShow)
                        return;

                    this._shouldShow = shouldShow;
                    this.notify('should-show');
                });
        }
    }

    _deleteDocks() {
        if (!this._allDocks.length)
            return;

        // Remove extra features
        this._workspaceIsolation.destroy();
        this._keyboardShortcuts.destroy();

        // Delete all docks
        this._allDocks.forEach(d => d.destroy());
        this._allDocks = [];
    }

    _restoreDash() {
        if (!this._oldDash)
            return;

        this._signalsHandler.removeWithLabel('old-dash-changes');
        this._propertyInjections.removeWithLabel('main-dash');
        this._methodInjections.removeWithLabel('main-dash');
        this._vfuncInjections.removeWithLabel('main-dash');

        let overviewControls = Main.overview._overview._controls;
        Main.overview._overview._controls.layout_manager._dash = this._oldDash;
        overviewControls.dash = this._oldDash;
        overviewControls._searchController._showAppsButton = this._oldDash.showAppsButton;
        Main.overview.dash.show();
        Main.overview.dash.set_height(-1); // reset default dash size
        // This force the recalculation of the icon size
        Main.overview.dash._maxHeight = -1;
    }

    get searchController() {
        return Main.overview._overview.controls._searchController;
    }

    _onShowAppsButtonToggled(button) {
        const { checked } = button;
        const overviewControls = Main.overview._overview.controls;

        if (!Main.overview.visible) {
            this.mainDock.dash.showAppsButton._fromDesktop = true;
            if (this._settings.get_boolean('animate-show-apps')) {
                Main.overview.show(OverviewControls.ControlsState.APP_GRID);
            } else {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    const oldAnimationTime = OverviewControls.SIDE_CONTROLS_ANIMATION_TIME;
                    Overview.ANIMATION_TIME = 1;
                    const id = Main.overview.connect('shown', () => {
                        Overview.ANIMATION_TIME = oldAnimationTime;
                        Main.overview.disconnect(id);
                    });
                    Main.overview.show(OverviewControls.ControlsState.APP_GRID);
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            if (!checked && this.mainDock.dash.showAppsButton._fromDesktop) {
                if (this._settings.get_boolean('animate-show-apps')) {
                    Main.overview.hide();
                    this.mainDock.dash.showAppsButton._fromDesktop = false;
                } else {
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        const oldAnimationTime = Overview.ANIMATION_TIME;
                        Overview.ANIMATION_TIME = 1;
                        const id = Main.overview.connect('hidden', () => {
                            Overview.ANIMATION_TIME = oldAnimationTime;
                            Main.overview.disconnect(id);
                        });
                        Main.overview.hide();
                        this.mainDock.dash.showAppsButton._fromDesktop = false;
                        return GLib.SOURCE_REMOVE;
                    });
                }
            } else {
                // TODO: I'm not sure how reliable this is, we might need to move the
                // _onShowAppsButtonToggled logic into the extension.
                if (!checked) {
                    this.mainDock.dash.showAppsButton._fromDesktop = false;
                }

                // Instead of "syncing" the stock button, let's call its callback directly.
                overviewControls._onShowAppsButtonToggled.call(overviewControls);
            }
        }

        // Because we "disconnected" from the search controller, we have to manage its state.
        this.searchController._setSearchActive(false);
    }

    destroy() {
        this.emit('destroy');
        if (this._toggleLater) {
            Meta.later_remove(this._toggleLater);
            delete this._toggleLater;
        }
        this._restoreDash();
        this._deleteDocks();
        this._revertPanelCorners();
        if (this._oldSelectorMargin)
            Main.overview._overview.controls._searchController.margin_bottom = this._oldSelectorMargin;
        if (this._fm1Client) {
            this._fm1Client.destroy();
            this._fm1Client = null;
        }
        this._remoteModel.destroy();
        this._settings.run_dispose();
        this._settings = null;
        this._oldDash = null;

        Me.imports.extension.dockManager = null;
    }

    /**
     * Adjust Panel corners
     */
    _adjustPanelCorners() {
        let position = Utils.getPosition();
        let isHorizontal = ((position == St.Side.TOP) || (position == St.Side.BOTTOM));
        let extendHeight   = this._settings.get_boolean('extend-height');
        let fixedIsEnabled = this._settings.get_boolean('dock-fixed');
        let dockOnPrimary  = this._settings.get_boolean('multi-monitor') ||
                             this._preferredMonitorIndex == Main.layoutManager.primaryIndex;

        if (!isHorizontal && dockOnPrimary && extendHeight && fixedIsEnabled) {
            Main.panel._rightCorner.hide();
            Main.panel._leftCorner.hide();
        }
        else
            this._revertPanelCorners();
    }

    _revertPanelCorners() {
        Main.panel._leftCorner.show();
        Main.panel._rightCorner.show();
    }
};
Signals.addSignalMethods(DockManager.prototype);

// This class drives long-running icon animations, to keep them running in sync
// with each other, and to save CPU by pausing them when the dock is hidden.
var IconAnimator = class DashToDock_IconAnimator {
    constructor(actor) {
        this._count = 0;
        this._started = false;
        this._animations = {
            dance: [],
        };
        this._timeline = new Clutter.Timeline({
            duration: 3000,
            repeat_count: -1,
            actor
        });

        this._timeline.connect('new-frame', () => {
            const progress = this._timeline.get_progress();
            const danceRotation = progress < 1/6 ? 15*Math.sin(progress*24*Math.PI) : 0;
            const dancers = this._animations.dance;
            for (let i = 0, iMax = dancers.length; i < iMax; i++) {
                dancers[i].target.rotation_angle_z = danceRotation;
            }
        });
    }

    destroy() {
        this._timeline.stop();
        this._timeline = null;
        for (const name in this._animations) {
            const pairs = this._animations[name];
            for (let i = 0, iMax = pairs.length; i < iMax; i++) {
                const pair = pairs[i];
                pair.target.disconnect(pair.targetDestroyId);
            }
        }
        this._animations = null;
    }

    pause() {
        if (this._started && this._count > 0) {
            this._timeline.stop();
        }
        this._started = false;
    }

    start() {
        if (!this._started && this._count > 0) {
            this._timeline.start();
        }
        this._started = true;
    }

    addAnimation(target, name) {
        const targetDestroyId = target.connect('destroy', () => this.removeAnimation(target, name));
        this._animations[name].push({ target, targetDestroyId });
        if (this._started && this._count === 0) {
            this._timeline.start();
        }
        this._count++;
    }

    removeAnimation(target, name) {
        const pairs = this._animations[name];
        for (let i = 0, iMax = pairs.length; i < iMax; i++) {
            const pair = pairs[i];
            if (pair.target === target) {
                target.disconnect(pair.targetDestroyId);
                pairs.splice(i, 1);
                this._count--;
                if (this._started && this._count === 0) {
                    this._timeline.stop();
                }
                return;
            }
        }
    }
};

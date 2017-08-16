import { AnimationOptions } from '../animations/interfaces';
import { FrameworkDelegate } from './framework-delegate';
import { NavController } from './nav-controller';

import {
  DIRECTION_BACK,
  DIRECTION_FORWARD,
  STATE_ATTACHED,
  STATE_DESTROYED,
  STATE_INITIALIZED,
  ComponentDataPair,
  NavOptions,
  NavResult,
  TransitionInstruction,
  isViewController,
  setZIndex,
  toggleHidden
} from './nav-utils';


import { ViewController } from './view-controller';
import { ViewControllerImpl } from './view-controller-impl';

import { assert, isDef, isNumber } from '../utils/helpers';
import { NAV_ID_START, VIEW_ID_START } from '../utils/ids';

import { DanTransition } from './transitions/dan-transition';
import { Transition } from './transitions/transition';
import { destroy, getRootTransitionId, nextId } from './transitions/transition-controller';

const queueMap = new Map<number, TransitionInstruction[]>();

// public api
export function canGoBack(nav: NavController) {
  return nav.views && nav.views.length > 0;
}

export function canSwipeBack() {
  return true;
  // TODO - implement this for real
}

export function getFirstView(nav: NavController): ViewController {
  return nav.views && nav.views.length > 0 ? nav.views[0] : null;
}

export function getActiveView(nav: NavController): ViewController {
  return nav.views && nav.views.length > 0 ? nav.views[nav.views.length - 1] : null;
}

export function getActiveChildNavs(nav: NavController): NavController[] {
  return nav.childNavs ? nav.childNavs : [];
}

export function getViews(nav: NavController): ViewController[] {
  return nav.views ? nav.views : [];
}

export function push(nav: NavController, delegate: FrameworkDelegate, component: any, data?: any, opts?: NavOptions, done? : () => void): Promise<any> {
  return queueTransaction({
    insertStart: -1,
    insertViews: [{page: component, params: data}],
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function insert(nav: NavController, delegate: FrameworkDelegate, insertIndex: number, page: any, params?: any, opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    insertStart: insertIndex,
    insertViews: [{ page: page, params: params }],
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function insertPages(nav: NavController, delegate: FrameworkDelegate, insertIndex: number, insertPages: any[], opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    insertStart: insertIndex,
    insertViews: insertPages,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function pop(nav: NavController, delegate: FrameworkDelegate, opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    removeStart: -1,
    removeCount: 1,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function popToRoot(nav: NavController, delegate: FrameworkDelegate, opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    removeStart: 1,
    removeCount: -1,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function popTo(nav: NavController, delegate: FrameworkDelegate, indexOrViewCtrl: any, opts?: NavOptions, done?: () => void): Promise<any> {
  const config: TransitionInstruction = {
    removeStart: -1,
    removeCount: -1,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  };
  if (isViewController(indexOrViewCtrl)) {
    config.removeView = indexOrViewCtrl;
    config.removeStart = 1;
  } else if (isNumber(indexOrViewCtrl)) {
    config.removeStart = indexOrViewCtrl + 1;
  }
  return queueTransaction(config, done);
}

export function remove(nav: NavController, delegate: FrameworkDelegate, startIndex: number, removeCount: number = 1, opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    removeStart: startIndex,
    removeCount: removeCount,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function removeView(nav: NavController, delegate: FrameworkDelegate, viewController: ViewController, opts?: NavOptions, done?: () => void): Promise<any> {
  return queueTransaction({
    removeView: viewController,
    removeStart: 0,
    removeCount: 1,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}

export function setRoot(nav: NavController, delegate: FrameworkDelegate, page: any, params?: any, opts?: NavOptions, done?: () => void): Promise<any> {
  return setPages(nav, delegate, [{ page: page, params: params }], opts, done);
}

export function setPages(nav: NavController, delegate: FrameworkDelegate, componentDataPars: ComponentDataPair[], opts? : NavOptions, done?: () => void): Promise<any> {
  if (!isDef(opts)) {
    opts = {};
  }
  if (opts.animate !== true) {
    opts.animate = false;
  }
  return queueTransaction({
    insertStart: 0,
    insertViews: componentDataPars,
    removeStart: 0,
    removeCount: -1,
    opts: opts,
    nav: nav,
    delegate: delegate,
    id: nav.id
  }, done);
}







// private api, exported for testing
export function queueTransaction(ti: TransitionInstruction, done: () => void): Promise<boolean> {
  const promise = new Promise<boolean>((resolve, reject) => {
    ti.resolve = resolve;
    ti.reject = reject;
  });
  ti.done = done;

  // Normalize empty
  if (ti.insertViews && ti.insertViews.length === 0) {
    ti.insertViews = undefined;
  }

  // Normalize empty
  if (ti.insertViews && ti.insertViews.length === 0) {
    ti.insertViews = undefined;
  }

  // Enqueue transition instruction
  addToQueue(ti);

  // if there isn't a transition already happening
  // then this will kick off this transition
  nextTransaction(ti.nav);

  return promise;
}

export function nextTransaction(nav: NavController): Promise<any> {

  if (nav.transitioning) {
    return Promise.resolve();
  }

  const topTransaction = getTopTransaction(nav.id);
  if (!topTransaction) {
    return Promise.resolve();
  }

  return initializeViewBeforeTransition(topTransaction).then(([enteringView, leavingView]) => {
    return loadViewAndTransition(nav, enteringView, leavingView, topTransaction);
  }).then((result: NavResult) => {
    return successfullyTransitioned(result, topTransaction);
  }).catch((err: Error) => {
    return transitionFailed(err, topTransaction);
  });
}

export function successfullyTransitioned(result: NavResult, ti: TransitionInstruction) {
  const queue = getQueue(ti.id);
  if (!queue) {
    // TODO, make throw error in the future
    return fireError(new Error('Queue is null, the nav must have been destroyed'), ti);
  }

  ti.nav.isViewInitialized = true;
  ti.nav.transitionId = null;
  ti.nav.transitioning = false;

  // TODO - check if it's a swipe back

  // kick off next transition for this nav I guess
  nextTransaction(ti.nav);

  if (ti.done) {
    ti.done(
      result.hasCompleted,
      result.requiresTransition,
      result.enteringName,
      result.leavingName,
      result.direction
    );
  }
  ti.resolve(result.hasCompleted);
  console.log('success');
}

export function transitionFailed(error: Error, ti: TransitionInstruction) {
  const queue = getQueue(ti.nav.id);
  if (!queue) {
    // TODO, make throw error in the future
    return fireError(new Error('Queue is null, the nav must have been destroyed'), ti);
  }

  ti.nav.transitionId = null;
  resetQueue(ti.nav.id);

  ti.nav.transitioning = false;

  // TODO - check if it's a swipe back

  // kick off next transition for this nav I guess
  nextTransaction(ti.nav);

  fireError(error, ti);
  console.log('fail');
}

export function fireError(error: Error, ti: TransitionInstruction) {
  if (ti.done) {
    ti.done(false, false, error.message);
  }
  if (ti.reject && !ti.nav.destroyed) {
    ti.reject(error);
  } else {
    ti.resolve(false);
  }
}

export function loadViewAndTransition(nav: NavController, enteringView: ViewController, leavingView: ViewController, ti: TransitionInstruction) {
  if (!ti.requiresTransition) {
    // transition is not required, so we are already done!
    // they're inserting/removing the views somewhere in the middle or
    // beginning, so visually nothing needs to animate/transition
    // resolve immediately because there's no animation that's happening
    return Promise.resolve({
      hasCompleted: true,
      requiresTransition: false
    });
  }

  nav.transitionId = getRootTransitionId(nav) || nextId();

  // create the transition options
  const animationOpts: AnimationOptions = {
    animation: ti.opts.animation,
    direction: ti.opts.direction,
    duration: (ti.opts.animate === false ? 0 : ti.opts.duration),
    easing: ti.opts.easing,
    isRTL: false, // TODO
    ev: ti.opts.event,
  };

  const transition = new DanTransition(enteringView, leavingView, animationOpts);

  //const transition = getTransition(stateData.transitionId, enteringView, animationOpts);

  if (nav.swipeToGoBackTransition) {
    nav.swipeToGoBackTransition.destroy();
    nav.swipeToGoBackTransition = null;
  }

  // it's a swipe to go back transition
  if (transition.isRoot() && ti.opts.progressAnimation) {
    nav.swipeToGoBackTransition = transition;
  }

  // use the resolve function of this promise to trigger the
  // beginTransitioning method
  const promiseToReturn = new Promise<any>((resolve) => {
    transition.registerStart(resolve);
  });


  return attachViewToDom(nav, enteringView, ti.delegate).then(() => {
    if (!transition.hasChildren) {
      // lowest level transition, so kick it off and let it bubble up to start all of them
      transition.start();
    }
    return promiseToReturn;
  }).then(() => {
    return executeAsyncTransition(nav, transition, enteringView, leavingView, ti.opts);
  });
}

export function executeAsyncTransition(nav: NavController, transition: Transition, enteringView: ViewController, leavingView: ViewController, opts: NavOptions): Promise<NavResult> {
  assert(nav.transitioning, 'must be transitioning');
  nav.transitionId = null;
  setZIndex(nav.isPortal, enteringView, leavingView, opts.direction);

  // always ensure the entering view is viewable
  // ******** DOM WRITE ****************
  // TODO, figure out where we want to read this data from
  enteringView && toggleHidden(enteringView.element, true, true);

  // always ensure the leaving view is viewable
  // ******** DOM WRITE ****************
  leavingView && toggleHidden(leavingView.element, true, true);

  // initialize the transition
  transition.init()

  const shouldNotAnimate = (!nav.isViewInitialized && nav.views.length === 1) && !nav.isPortal;
  if (Ionic.config.get('animate') === false || shouldNotAnimate) {
    opts.animate = false;
  }

  if (!opts.animate) {
    // if it was somehow set to not animation, then make the duration zero
    transition.duration(0);
  }

  transition.beforeAddRead(() => {
    fireViewWillLifecycles(enteringView, leavingView);
  });

  // get the set duration of this transition
  const duration = transition.getDuration();

  // create a callback for when the animation is done
  const transitionCompletePromise = new Promise(resolve => {
    transition.onFinish(resolve);
  });

  if (transition.isRoot()) {
    if (duration > DISABLE_APP_MINIMUM_DURATION && opts.disableApp !== false) {
      // if this transition has a duration and this is the root transition
      // then set that the app is actively disabled
      //this._app.setEnabled(false, duration + ACTIVE_TRANSITION_OFFSET, opts.minClickBlockDuration);

      // TODO - figure out how to disable the app
    }

    if (opts.progressAnimation) {
      // this is a swipe to go back, just get the transition progress ready
      // kick off the swipe animation start
      transition.progressStart();

    } else {
      // only the top level transition should actually start "play"
      // kick it off and let it play through
      // ******** DOM WRITE ****************
      transition.play();
    }
  }

  return transitionCompletePromise.then(() => {
    return transitionFinish(nav, transition, opts);
  });
}

export function transitionFinish(nav: NavController, transition: Transition, opts: NavOptions): NavResult {
  if (transition.hasCompleted) {
    transition.enteringView && transition.enteringView.didEnter();
    transition.leavingView && transition.leavingView.didLeave();

    cleanUpView(nav, transition.enteringView);
  } else {
    cleanUpView(nav, transition.leavingView);
  }

  if (transition.isRoot())  {
    destroy(transition.transitionId);

    // TODO - enable app

    nav.transitioning = false;

    // TODO - navChange on the deep linker used to be called here

    if (opts.keyboardClose) {
      // TODO - close the keyboard
    }
  }

  return {
    hasCompleted: transition.hasCompleted,
    requiresTransition: true,
    direction: opts.direction
  }
}

export function cleanUpView(nav: NavController, activeViewController: ViewController) {
  if (nav.destroyed) {
    return;
  }
  const activeIndex = nav.views.indexOf(activeViewController);
  for (let i  = nav.views.length - 1; i >= 0; i--) {
    const inactiveViewController = nav.views[i];
    if (i > activeIndex) {
      // this view comes after the active view
      inactiveViewController.willUnload();
      destroyView(nav, inactiveViewController);
    } else if ( i < activeIndex && !nav.isPortal) {
      // this view comes before the active view
      // and it is not a portal then ensure it is hidden
      toggleHidden(inactiveViewController.element, true, false);
    }
    // TODO - review existing z index code!
  }
}


export function fireViewWillLifecycles(enteringView: ViewController, leavingView: ViewController) {
  leavingView && leavingView.willLeave(!enteringView);
  enteringView && enteringView.willEnter();
}

export function attachViewToDom(nav: NavController, enteringView: ViewController, delegate: FrameworkDelegate) {
  return delegate.attachViewToDom(nav, enteringView);
}

export function initializeViewBeforeTransition(ti: TransitionInstruction): Promise<ViewController[]> {
  let leavingView: ViewController = null;
  let enteringView: ViewController = null;
  return startTransaction(ti).then(() => {
    const viewControllers = convertComponentToViewController(ti);
    ti.insertViews = viewControllers;
    leavingView = getActiveView(ti.nav);
    enteringView = getEnteringView(ti, ti.nav, leavingView);

    if (!leavingView && !enteringView) {
      return Promise.reject(new Error('No views in the stack to remove'));
    }

    // mark state as initialized
    enteringView.state = STATE_INITIALIZED;
    ti.requiresTransition = (ti.enteringRequiresTransition || ti.leavingRequiresTransition) && enteringView !== leavingView;
    return testIfViewsCanLeaveAndEnter(enteringView, leavingView, ti);
  }).then(() => {
    return updateNavStacks(enteringView, leavingView, ti);
  }).then(() => {
    return [enteringView, leavingView];
  });
}

// called _postViewInit in old world
export function updateNavStacks(enteringView: ViewController, leavingView: ViewController, ti: TransitionInstruction): Promise<any> {
  return Promise.resolve().then(() => {
    assert(!!(leavingView || enteringView), 'Both leavingView and enteringView are null');
    assert(!!ti.resolve, 'resolve must be valid');
    assert(!!ti.reject, 'reject must be valid');

    const destroyQueue: ViewController[] = [];

    ti.opts = ti.opts || {};

    if (isDef(ti.removeStart)) {
      assert(ti.removeStart >= 0, 'removeStart can not be negative');
      assert(ti.removeStart >= 0, 'removeCount can not be negative');

      for (let i = 0; i < ti.removeCount; i++) {
        const view = ti.nav.views[i + ti.removeStart];
        if (view && view !== enteringView && view !== leavingView) {
          destroyQueue.push(view);
        }
      }

      ti.opts.direction = ti.opts.direction || DIRECTION_BACK;
    }

    const finalBalance = ti.nav.views.length + (ti.insertViews ? ti.insertViews.length : 0) - (ti.removeCount ? ti.removeCount : 0);
    assert(finalBalance >= 0, 'final balance can not be negative');
    if (finalBalance === 0 && !ti.nav.isPortal) {
      console.warn(`You can't remove all the pages in the navigation stack. nav.pop() is probably called too many times.`);
      throw new Error('Navigation stack needs at least one root page');
    }

    // At this point the transition can not be rejected, any throw should be an error
    // there are views to insert
    if (ti.insertViews) {
      // manually set the new view's id if an id was passed in the options
      if (isDef(ti.opts.id)) {
        enteringView.id = ti.opts.id;
      }

      // add the views to the stack
      for (let i = 0; i < ti.insertViews.length; i++) {
        insertViewIntoNav(ti.nav, ti.insertViews[i], ti.insertStart + i);
      }

      if (ti.enteringRequiresTransition) {
        // default to forward if not already set
        ti.opts.direction = ti.opts.direction || DIRECTION_FORWARD;
      }
    }

    // if the views to be removed are in the beginning or middle
    // and there is not a view that needs to visually transition out
    // then just destroy them and don't transition anything
    // batch all of lifecycles together
    if (destroyQueue && destroyQueue.length) {
      // TODO, figure out how the zone stuff should work in angular
      for (let i = 0; i < destroyQueue.length; i++) {
        const view = destroyQueue[i];
        view.willLeave(true);
        view.didLeave();
        view.willUnload();
      }

      const destroyQueuePromises: Promise<any>[] = [];
      for (const viewController of destroyQueue) {
        destroyQueuePromises.push(destroyView(ti.nav, viewController));
      }
      return Promise.all(destroyQueuePromises);
    }
    return null;
  }).then(() => {
    // set which animation it should use if it wasn't set yet
    if (ti.requiresTransition && !ti.opts.animation) {
      if (isDef(ti.removeStart)) {
        ti.opts.animation = (leavingView || enteringView).getTransitionName(ti.opts.direction);
      } else {
        ti.opts.animation = (enteringView || leavingView).getTransitionName(ti.opts.direction);
      }
    }
  });
}

export function destroyView(nav: NavController, viewController: ViewController) {
  return viewController.destroy().then(() => {
    return removeViewFromList(nav, viewController);
  });
}

export function removeViewFromList(nav: NavController, viewController: ViewController) {
  assert(viewController.state === STATE_ATTACHED || viewController.state === STATE_DESTROYED, 'view state should be loaded or destroyed');
  const index = nav.views.indexOf(viewController);
  assert(index > -1, 'view must be part of the stack');
  if (index >= 0) {
    nav.views.splice(index, 1);
  }
}

export function insertViewIntoNav(nav: NavController, view: ViewController, index: number) {
  const existingIndex = nav.views.indexOf(view);
  if (existingIndex > -1) {
    // this view is already in the stack!!
    // move it to its new location
    assert(view.nav === nav, 'view is not part of the nav');
    nav.views.splice(index, 0, nav.views.splice(existingIndex, 1)[0]);
  } else {
    assert(!view.nav || (nav.isPortal && view.nav === nav), 'nav is used');
    // this is a new view to add to the stack
    // create the new entering view
    view.nav = nav;

    // give this inserted view an ID
    viewIds++;
    if (!view.id) {
      view.id = `${nav.id}-${viewIds}`;
    }

    // insert the entering view into the correct index in the stack
    nav.views.splice(index, 0, view);
  }
}

export function testIfViewsCanLeaveAndEnter(enteringView: ViewController, leavingView: ViewController, ti: TransitionInstruction) {
  if (!ti.requiresTransition) {
    return Promise.resolve();
  }

  const promises: Promise<any>[] = [];


  if (leavingView) {
    promises.push(lifeCycleTest(leavingView, 'Leave'));
  }
  if (enteringView) {
    promises.push(lifeCycleTest(enteringView, 'Enter'));
  }

  if (promises.length === 0) {
    return Promise.resolve();
  }

  // darn, async promises, gotta wait for them to resolve
  return Promise.all(promises).then((values: any[]) => {
    if (values.some(result => result === false)) {
      ti.reject = null;
      throw new Error('canEnter/Leave returned false');
    }
  });
}

export function lifeCycleTest(viewController: ViewController, enterOrLeave: string) {
  const methodName = `ionViewCan${enterOrLeave}`;
  if (viewController.instance && viewController.instance[methodName]) {
    try {
      const result = viewController.instance[methodName];
      if (result instanceof Promise) {
        return result;
      }
      return Promise.resolve(result !== false);
    } catch (e) {
      return Promise.reject(new Error(`Unexpected error when calling ${methodName}: ${e.message}`));
    }
  }
  return Promise.resolve(true);
}

export function startTransaction(ti: TransitionInstruction): Promise<any> {

  const viewsLength = ti.nav.views ? ti.nav.views.length : 0;

  if (isDef(ti.removeView)) {
    assert(isDef(ti.removeStart), 'removeView needs removeStart');
    assert(isDef(ti.removeCount), 'removeView needs removeCount');

    const index = ti.nav.views.indexOf(ti.removeView());
    if (index < 0) {
      return Promise.reject(new Error('The removeView was not found'));
    }
    ti.removeStart += index;
  }

  if (isDef(ti.removeStart)) {
    if (ti.removeStart < 0) {
      ti.removeStart = (viewsLength - 1);
    }
    if (ti.removeCount < 0) {
      ti.removeCount = (viewsLength - ti.removeStart);
    }
    ti.leavingRequiresTransition = (ti.removeCount > 0) && ((ti.removeStart + ti.removeCount) === viewsLength);
  }

  if (isDef(ti.insertViews)) {
    // allow -1 to be passed in to auto push it on the end
    // and clean up the index if it's larger then the size of the stack
    if (ti.insertStart < 0 || ti.insertStart > viewsLength) {
      ti.insertStart = viewsLength;
    }
    ti.enteringRequiresTransition = (ti.insertStart === viewsLength);
  }

  ti.nav.transitioning = true;

  return Promise.resolve();
}

export function getEnteringView(ti: TransitionInstruction, nav: NavController, leavingView: ViewController): ViewController {
  if (ti.insertViews && ti.insertViews.length) {
    // grab the very last view of the views to be inserted
    // and initialize it as the new entering view
    return ti.insertViews[ti.insertViews.length - 1];
  }
  if (isDef(ti.removeStart)) {
    var removeEnd = ti.removeStart + ti.removeCount;
    for (let i = nav.views.length - 1; i >= 0; i--) {
      if ((i < ti.removeStart || i >= removeEnd) && nav.views[i] !== leavingView) {
        return nav.views[i];
      }
    }
  }
  return null;
}

export function convertViewsToViewControllers(views: any[]): ViewController[] {
  return views.map(view => {
    if (view) {
      if (isViewController(view)) {
        return view as ViewController;
      }
      // TODO - make this clean
      return (new ViewControllerImpl(view.page, view.params) as any) as ViewController;
    }
    return null;
  }).filter(view => !!view);
}

export function convertComponentToViewController(ti: TransitionInstruction): ViewController[] {
  if (ti.insertViews) {
    assert(ti.insertViews.length > 0, 'length can not be zero');
    const viewControllers = convertViewsToViewControllers(ti.insertViews);
    assert(ti.insertViews.length === viewControllers.length, 'lengths does not match');
    if (viewControllers.length === 0) {
      throw new Error('No views to insert');
    }

    for (const viewController of viewControllers) {
      if (viewController.nav && viewController.nav.id !== ti.id) {
        throw new Error('The view has already inserted into a different nav');
      }
      if (viewController.state === STATE_DESTROYED) {
        throw new Error('The view has already been destroyed');
      }
    }
    return viewControllers;
  }
  return [];
}

export function addToQueue(ti: TransitionInstruction) {
  const list = queueMap.get(ti.id) || [];
  list.push(ti);
  queueMap.set(ti.id, list);
}

export function getQueue(id: number) {
  return queueMap.get(id) || [];
}

export function resetQueue(id: number) {
  queueMap.set(id, []);
}

export function getTopTransaction(id: number) {
  const queue = getQueue(id);
  if (!queue.length) {
    return null;
  }
  const tmp = queue.concat();
  const toReturn = tmp.shift();
  queueMap.set(id, tmp);
  return toReturn;
}

export function getNextNavId() {
  return navControllerIds++;
}

let navControllerIds = NAV_ID_START;
let viewIds = VIEW_ID_START;
const DISABLE_APP_MINIMUM_DURATION = 64;
/**
 * Navigation panel and new comments-related functions and configuration.
 *
 * @module navPanel
 */

import CdError from './CdError';
import Comment from './Comment';
import Section from './Section';
import cd from './cd';
import userRegistry from './userRegistry';
import {
  animateLink,
  defined,
  handleApiReject,
  isCommentEdit,
  removeDuplicates,
  reorderArray,
} from './util';
import { getCurrentPageData, getUserGenders, makeRequestNoTimers } from './apiWrappers';
import { getWatchedSections, setVisits } from './options';
import { reloadPage } from './boot';

let newCount;
let unseenCount;
let lastFirstTimeSeenCommentId = null;
let newRevisions = [];
let notifiedAbout = [];
let notifications = [];
let isBackgroundCheckArranged = false;
let relevantNewCommentAnchor;

let $navPanel;
let $refreshButton;
let $previousButton;
let $nextButton;
let $firstUnseenButton;
let $commentFormButton;

/**
 * Tell the worker to wake the script up after a given interval.
 *
 * Chrome and probably other browsers throttle background tabs. To bypass this, we use a web worker
 * to wake the script up when we say, making it work as an alarm clock.
 *
 * @param {number} interval
 * @private
 */
function setAlarmViaWorker(interval) {
  cd.g.worker.postMessage({
    type: 'setAlarm',
    interval,
  });
}

/**
 * Remove an alarm set in {@link module:navPanel#setAlarmViaWorker}.
 *
 * @private
 */
function removeAlarmViaWorker() {
  cd.g.worker.postMessage({ type: 'removeAlarm' });
}

/**
 * Check for new comments in a web worker, update the navigation panel, and schedule the next check.
 *
 * @private
 */
async function checkForNewComments() {
  if (!cd.g.worker) return;

  if (document.hidden && !isBackgroundCheckArranged) {
    const callback = () => {
      $(document).off('visibilitychange', callback);
      isBackgroundCheckArranged = false;
      removeAlarmViaWorker();
      checkForNewComments();
    };
    $(document).on('visibilitychange', callback);

    const interval = Math.abs(
      cd.g.BACKGROUND_CHECK_FOR_NEW_COMMENTS_INTERVAL - cd.g.CHECK_FOR_NEW_COMMENTS_INTERVAL
    );
    setAlarmViaWorker(interval * 1000);
    isBackgroundCheckArranged = true;
    return;
  }

  // Precaution
  isBackgroundCheckArranged = false;

  const rvstartid = newRevisions.length ?
    newRevisions[newRevisions.length - 1] :
    mw.config.get('wgRevisionId');

  try {
    const revisionsResp = await makeRequestNoTimers({
      action: 'query',
      titles: cd.g.CURRENT_PAGE,
      prop: 'revisions',
      rvprop: ['ids', 'flags', 'size', 'comment'],
      rvdir: 'newer',
      rvstartid,
      rvlimit: 500,
      redirects: true,
      formatversion: 2,
    }).catch(handleApiReject);

    const revisions = (
      revisionsResp &&
      revisionsResp.query &&
      revisionsResp.query.pages &&
      revisionsResp.query.pages[0] &&
      revisionsResp.query.pages[0].revisions
    );
    if (!revisions) {
      throw new CdError({
        type: 'api',
        code: 'noData',
      });
    }

    const addedNewRevisions = revisions
      .filter((revision, i) => (
        i !== 0 &&
        !revision.minor &&
        Math.abs(revision.size - revisions[i - 1].size) >= cd.config.bytesToDeemComment &&
        !isCommentEdit(revision.comment)
      ))
      .map((revision) => revision.revid);
    newRevisions.push(...addedNewRevisions);

    // Precaution
    newRevisions = removeDuplicates(newRevisions);

    if (addedNewRevisions.length) {
      const { text } = await getCurrentPageData(false, true) || {};
      if (text === undefined) {
        console.error('No page text.');
      } else {
        cd.g.worker.postMessage({
          type: 'parse',
          text,
          g: {
            TIMESTAMP_REGEXP: cd.g.TIMESTAMP_REGEXP,
            TIMESTAMP_REGEXP_NO_TIMEZONE: cd.g.TIMESTAMP_REGEXP_NO_TIMEZONE,
            TIMESTAMP_PARSER: cd.g.TIMESTAMP_PARSER.toString(),
            TIMESTAMP_MATCHING_GROUPS: cd.g.TIMESTAMP_MATCHING_GROUPS,
            DIGITS: cd.g.DIGITS,
            LOCAL_TIMEZONE_OFFSET: cd.g.LOCAL_TIMEZONE_OFFSET,
            MESSAGES: cd.g.MESSAGES,
            CONTRIBS_PAGE: cd.g.CONTRIBS_PAGE,
            CONTRIBS_PAGE_LINK_REGEXP: cd.g.CONTRIBS_PAGE_LINK_REGEXP,
            ARTICLE_PATH_REGEXP: cd.g.ARTICLE_PATH_REGEXP,
            USER_NAMESPACES_REGEXP: cd.g.USER_NAMESPACES_REGEXP,
            UNHIGHLIGHTABLE_ELEMENTS_CLASSES: cd.g.UNHIGHLIGHTABLE_ELEMENTS_CLASSES,
            CURRENT_USER_NAME: cd.g.CURRENT_USER_NAME,
            CURRENT_USER_GENDER: cd.g.CURRENT_USER_GENDER,
            CURRENT_NAMESPACE_NUMBER: cd.g.CURRENT_NAMESPACE_NUMBER,
          },
          config: {
            customFloatingElementsSelectors: cd.config.customFloatingElementsSelectors,
            closedDiscussionsClasses: cd.config.closedDiscussionsClasses,
            elementsToExcludeClasses: cd.config.elementsToExcludeClasses,
            signatureScanLimit: cd.config.signatureScanLimit,
            foreignElementsInHeadlinesClasses: cd.config.foreignElementsInHeadlinesClasses,
            customForeignComponentChecker: cd.config.customForeignComponentChecker ?
              cd.config.customForeignComponentChecker.toString() :
              cd.config.customForeignComponentChecker,
          }
        });
        console.debug('sent message from the main thread', Date.now());
      }
    }
  } catch (e) {
    console.warn(e);
  }

  if (document.hidden) {
    setAlarmViaWorker(cd.g.BACKGROUND_CHECK_FOR_NEW_COMMENTS_INTERVAL * 1000);
    isBackgroundCheckArranged = true;
  } else {
    setAlarmViaWorker(cd.g.CHECK_FOR_NEW_COMMENTS_INTERVAL * 1000);
  }
}

/**
 * Callback for messages from the worker.
 *
 * @param {Event} e
 * @private
 */
async function onMessageFromWorker(e) {
  const message = e.data;

  if (message.type === 'wakeUp') {
    checkForNewComments();
  }

  if (message.type === 'parse') {
    const { comments } = message;

    let thisPageWatchedSections;
    try {
      ({ thisPageWatchedSections } = await getWatchedSections(true) || {});
    } catch (e) {
      console.warn('Couldn\'t load the settings from the server.');
    }

    comments.forEach((comment) => {
      comment.author = userRegistry.getUser(comment.authorName);
      delete comment.authorName;
    });

    // Keep in mind that we should account for the case when comments have been removed. For
    // example, the counter could be "+1" but then go back to displaying the refresh icon which
    // means 0 new comments.
    const newComments = comments
      .filter((comment) => comment.anchor && !Comment.getCommentByAnchor(comment.anchor));
    const interestingNewComments = newComments.filter((comment) => {
      if (comment.own) {
        return false;
      }
      if (cd.settings.notificationsBlacklist.includes(comment.author.name)) {
        return false;
      }
      if (comment.toMe) {
        return true;
      }
      if (!thisPageWatchedSections) {
        return false;
      }

      // Is this section watched by means of an upper level section?
      const sections = Section.getSectionsByHeadline(comment.sectionHeadline);
      for (const section of sections) {
        const watchedAncestor = section.getWatchedAncestor(true);
        if (watchedAncestor) {
          comment.watchedSectionHeadline = watchedAncestor.headline;
          return true;
        }
      }
    });

    if (interestingNewComments[0]) {
      relevantNewCommentAnchor = interestingNewComments[0].anchor;
    } else if (newComments[0]) {
      relevantNewCommentAnchor = newComments[0].anchor;
    }

    const newCommentsBySection = {};
    newComments.forEach((comment) => {
      if (!newCommentsBySection[comment.sectionAnchor]) {
        newCommentsBySection[comment.sectionAnchor] = [];
      }
      newCommentsBySection[comment.sectionAnchor].push(comment);
    });

    let tooltipText;
    if (newComments.length) {
      tooltipText = `${cd.s('navpanel-newcomments-count', newComments.length)} (R)`;
      Object.keys(newCommentsBySection).forEach((anchor) => {
        const headline = newCommentsBySection[anchor][0].sectionHeadline ?
          cd.s('navpanel-newcomments-insection', newCommentsBySection[anchor][0].sectionHeadline) :
          mw.msg('parentheses', cd.s('navpanel-newcomments-outsideofsections'));
        tooltipText += `\n\n${headline}`;
        newCommentsBySection[anchor].forEach((comment) => {
          tooltipText += `\n`;
          if (comment.toMe) {
            tooltipText += `${cd.s('navpanel-newcomments-toyou')} `;
          }
          const author = comment.author.name || cd.s('navpanel-newcomments-unknownauthor');
          const date = comment.date ?
            cd.util.formatDate(comment.date) :
            cd.s('navpanel-newcomments-unknowndate');
          tooltipText += `${author}, ${date}`;
        });
      });
    } else {
      tooltipText = `${cd.s('navpanel-refresh')} (R)`;
    }

    $refreshButton
      .text(newComments.length ? `+${newComments.length}` : ``)
      .attr('title', tooltipText);
    if (interestingNewComments.length) {
      $refreshButton.addClass('cd-navPanel-refreshButton-interesting');
    } else {
      $refreshButton.removeClass('cd-navPanel-refreshButton-interesting');
    }

    // Add new comment notifications to the end of each updated section.
    $('.cd-refreshButtonContainer').remove();
    const sectionAnchors = removeDuplicates(newComments.map((comment) => comment.sectionAnchor));
    sectionAnchors.forEach((anchor) => {
      const section = Section.getSectionByAnchor(anchor);
      if (!section) return;

      const button = new OO.ui.ButtonWidget({
        label: `${cd.s('section-newcomments')}. ${cd.s('navpanel-refresh-tooltip')}.`,
        framed: false,
        classes: ['cd-button', 'cd-sectionButton'],
      });
      button.on('click', () => {
        const commentAnchor = newComments.find((comment) => comment.sectionAnchor === anchor)
          .anchor;
        reloadPage({ commentAnchor });
      });

      const $lastElement = section.$replyButton ?
        section.$replyButton.closest('ul, ol') :
        section.$elements[section.$elements.length - 1];
      $('<div>')
        .addClass('cd-refreshButtonContainer')
        .addClass('cd-sectionButtonContainer')
        .append(button.$element)
        .insertAfter($lastElement);
    });

    const notifyAbout = interestingNewComments.filter((comment) => (
      !notifiedAbout.some((commentNotifiedAbout) => commentNotifiedAbout.anchor === comment.anchor)
    ));

    let notifyAboutBrowser = [];
    if (cd.settings.browserNotifications === 'all') {
      notifyAboutBrowser = notifyAbout;
    } else if (cd.settings.browserNotifications === 'toMe') {
      notifyAboutBrowser = notifyAbout.filter((comment) => comment.toMe);
    }

    let notifyAboutRegular = [];
    if (cd.settings.notifications === 'all') {
      notifyAboutRegular = notifyAbout;
    } else if (cd.settings.notifications === 'toMe') {
      notifyAboutRegular = notifyAbout.filter((comment) => comment.toMe);
    }
    if (cd.settings.notifications !== 'none' && notifyAboutRegular.length) {
      // Combine with content of notifications that were displayed but are still open (i.e., the
      // user most likely didn't see them because the tab is in the background).
      notifications.slice().reverse().some((notification) => {
        if (notification.notification.isOpen) {
          notifyAboutRegular.push(...notification.comments);
          return false;
        } else {
          return true;
        }
      });
    }

    const authors = removeDuplicates(notifyAboutRegular.concat(notifyAboutBrowser))
      .map((comment) => comment.author)
      .filter(defined);
    await getUserGenders(authors, true);

    if (notifyAboutRegular.length) {
      let html;
      let href;
      if (notifyAboutRegular.length === 1) {
        const comment = notifyAboutRegular[0];
        href = mw.util.getUrl(`${cd.g.CURRENT_PAGE}${comment.anchor ? `#${comment.anchor}` : ''}`);
        if (comment.toMe) {
          const formsDataWillNotBeLost = (
            cd.commentForms.some((commentForm) => commentForm.isAltered()) ?
            ' ' + mw.msg('parentheses', cd.s('notification-formdata')) :
            ''
          );
          const where = comment.watchedSectionHeadline ?
            ' ' + cd.s('notification-part-insection', comment.watchedSectionHeadline) :
            ' ' + cd.s('notification-part-onthispage');
          html = cd.s(
            'notification-toyou',
            comment.author.name,
            comment.author,
            where,
            href,
            formsDataWillNotBeLost
          );
        } else {
          const formsDataWillNotBeLost = (
            cd.commentForms.some((commentForm) => commentForm.isAltered()) ?
            ' ' + mw.msg('parentheses', cd.s('notification-formdata')) :
            ''
          );
          html = cd.s(
            'notification-insection',
            comment.author.name,
            comment.author,
            comment.watchedSectionHeadline,
            href,
            formsDataWillNotBeLost
          );
        }
      } else {
        const isCommonSection = notifyAboutRegular
          .every((comment) => comment.sectionAnchor === notifyAboutRegular[0].sectionAnchor);
        const section = isCommonSection ? notifyAboutRegular[0].watchedSectionHeadline : null;
        href = mw.util.getUrl(`${cd.g.CURRENT_PAGE}${section ? `#${section}` : ''}`);
        const where = section ?
          ' ' + cd.s('notification-part-insection', section) :
          ' ' + cd.s('notification-part-onthispage');
        const formsDataWillNotBeLost = (
          cd.commentForms.some((commentForm) => commentForm.isAltered()) ?
          ' ' + mw.msg('parentheses', cd.s('notification-formdata')) :
          ''
        );
        html = cd.s(
          'notification-newcomments',
          notifyAboutRegular.length,
          where,
          href,
          formsDataWillNotBeLost
        );
      }

      navPanel.closeAllNotifications();
      const $body = animateLink(html, 'cd-notification-reloadPage', (e) => {
        e.preventDefault();
        reloadPage({ commentAnchor: notifyAboutRegular[0].anchor });
        notification.close();
      });
      const notification = mw.notification.notify($body);
      notifications.push({
        notification,
        comments: notifyAboutRegular,
      });
    }

    if (
      !document.hasFocus() &&
      Notification.permission === 'granted' &&
      notifyAboutBrowser.length
    ) {
      let body;
      // We use a tag so that there aren't duplicate notifications when the same page is opened in
      // two tabs.
      let tag = 'convenient-discussions-';
      const comment = notifyAboutBrowser[0];
      if (notifyAboutBrowser.length === 1) {
        tag += comment.anchor;
        if (comment.toMe) {
          const where = comment.sectionHeadline ?
            ' ' + cd.s('notification-part-insection', comment.sectionHeadline) :
            '';
          body = cd.s(
            'notification-toyou-browser',
            comment.author.name,
            comment.author,
            where,
            cd.g.CURRENT_PAGE
          );
        } else {
          body = cd.s(
            'notification-insection-browser',
            comment.author.name,
            comment.author,
            comment.sectionHeadline,
            cd.g.CURRENT_PAGE
          );
        }
      } else {
        const isCommonSection = notifyAbout
          .every((comment) => comment.sectionAnchor === notifyAbout[0].sectionAnchor);
        const where = isCommonSection ?
          ' ' + cd.s('notification-part-insection', notifyAbout[0].sectionHeadline) :
          '';
        body = cd.s(
          'notification-newcomments-browser',
          notifyAbout.length,
          where,
          cd.g.CURRENT_PAGE
        );
        tag += notifyAboutBrowser[notifyAboutBrowser.length - 1].anchor;
      }

      const notification = new Notification(mw.config.get('wgSiteName'), { body, tag });
      notification.onclick = () => {
        parent.focus();
        // Just in case, old browsers. TODO: delete?
        window.focus();
        reloadPage({ commentAnchor: comment.anchor });
      };
    }

    notifiedAbout.push(...notifyAbout);
  }
}

const navPanel = {
  /**
   * Property indicating that the mouse is over the navigation panel.
   *
   * @type {boolean}
   */
  mouseOverNavPanel: false,

  /**
   * Render the navigation panel. This is done when the page is first loaded or created.
   */
  async mount() {
    $navPanel = $('<div>')
      .attr('id', 'cd-navPanel')
      .on('mouseenter', () => {
        this.isMouseOver = true;
      })
      .on('mouseleave', () => {
        this.isMouseOver = false;
      })
      .appendTo(document.body);
    $refreshButton = $('<div>')
      .addClass('cd-navPanel-button')
      .attr('id', 'cd-navPanel-refreshButton')
      .attr('title', `${cd.s('navpanel-refresh')} (R)`)
      .on('click', () => {
        this.refreshClick();
      })
      .appendTo($navPanel);
    $previousButton = $('<div>')
      .addClass('cd-navPanel-button')
      .attr('id', 'cd-navPanel-previousButton')
      .attr('title', `${cd.s('navpanel-previous')} (W)`)
      .on('click', () => {
        this.goToPreviousNewComment();
      })
      .hide()
      .appendTo($navPanel);
    $nextButton = $('<div>')
      .addClass('cd-navPanel-button')
      .attr('id', 'cd-navPanel-nextButton')
      .attr('title', `${cd.s('navpanel-next')} (S)`)
      .on('click', () => {
        this.goToNextNewComment();
      })
      .hide()
      .appendTo($navPanel);
    $firstUnseenButton = $('<div>')
      .addClass('cd-navPanel-button')
      .attr('id', 'cd-navPanel-firstUnseenButton')
      .attr('title', `${cd.s('navpanel-firstunseen')} (F)`)
      .on('click', () => {
        this.goToFirstUnseenComment();
      })
      .hide()
      .appendTo($navPanel);
    $commentFormButton = $('<div>')
      .addClass('cd-navPanel-button')
      .attr('id', 'cd-navPanel-commentFormButton')
      .attr('title', cd.s('navpanel-commentform'))
      .on('click', () => {
        this.goToCommentForm();
      })
      .hide()
      .appendTo($navPanel);

    if (cd.g.worker) {
      cd.g.worker.onmessage = onMessageFromWorker;
      setAlarmViaWorker(cd.g.CHECK_FOR_NEW_COMMENTS_INTERVAL * 1000);
    }

    this.updateCommentFormButton();
  },

  /**
   * Check is the navigation panel is mounted. For most of the practical purposes, does the same as
   * the `!convenientDiscussions.g.pageIsInactive` check.
   *
   * @returns {boolean}
   */
  isMounted() {
    return Boolean($navPanel);
  },

  /**
   * Highlight new comments and update the navigation panel. A promise obtained from {@link
   * module:options.getVisits} should be provided.
   *
   * @param {Promise} visitsRequest
   * @param {Comment[]} [memorizedUnseenCommentAnchors=[]]
   * @fires newCommentsMarked
   */
  async processVisits(visitsRequest, memorizedUnseenCommentAnchors = []) {
    let visits;
    let thisPageVisits;
    try {
      ({ visits, thisPageVisits } = await visitsRequest);
    } catch (e) {
      console.warn('Couldn\'t load the settings from the server.', e);
      return;
    }

    // These variables are not used anywhere in the script but can be helpful for testing purposes.
    cd.g.visits = visits;
    cd.g.thisPageVisits = thisPageVisits;

    const currentUnixTime = Math.floor(Date.now() / 1000);

    // Cleanup
    for (let i = thisPageVisits.length - 1; i >= 0; i--) {
      if (thisPageVisits[i] < currentUnixTime - 60 * cd.g.HIGHLIGHT_NEW_COMMENTS_INTERVAL) {
        thisPageVisits.splice(0, i);
        break;
      }
    }

    if (thisPageVisits.length) {
      const newComments = cd.comments.filter((comment) => {
        comment.newness = null;

        if (!comment.date) {
          return false;
        }

        const isUnseen = memorizedUnseenCommentAnchors
          .some((anchor) => anchor === comment.anchor);
        const commentUnixTime = Math.floor(comment.date.getTime() / 1000);
        if (commentUnixTime > thisPageVisits[0]) {
          comment.newness = (
            (commentUnixTime > thisPageVisits[thisPageVisits.length - 1] && !comment.own) ||
            isUnseen
          ) ?
            'unseen' :
            'new';
          return true;
        }

        return false;
      });
      const floatingRects = newComments.length ?
        cd.g.specialElements.floating.map((el) => el.getBoundingClientRect()) :
        undefined;
      newComments.forEach((comment) => {
        comment.configureLayers(false, floatingRects)
      });

      // Faster to add them in one sequence.
      newComments.forEach((comment) => {
        comment.addLayers();
      });
    }

    thisPageVisits.push(String(currentUnixTime));

    setVisits(visits);

    this.fill();
    this.registerSeenComments();

    /**
     * New comments have been marked.
     *
     * @event newCommentsMarked
     */
    mw.hook('convenientDiscussions.newCommentsMarked').fire();
  },

  /**
   * Reset the navigation panel to the initial state. This is done after page refreshes. (Comment
   * forms are expected to be restored already.)
   */
  reset() {
    lastFirstTimeSeenCommentId = null;
    newRevisions = [];
    notifiedAbout = [];
    relevantNewCommentAnchor = null;

    removeAlarmViaWorker();
    setAlarmViaWorker(cd.g.CHECK_FOR_NEW_COMMENTS_INTERVAL * 1000);
    isBackgroundCheckArranged = false;

    $refreshButton
      .empty()
      .attr('title', `${cd.s('navpanel-refresh')} (R)`);
    $previousButton.hide();
    $nextButton.hide();
    $firstUnseenButton.hide();
    $commentFormButton.hide();

    this.updateCommentFormButton();
  },

  /**
   * Count new and unseen comments on the page, and update the navigation panel to reflect that.
   */
  fill() {
    newCount = cd.comments.filter((comment) => comment.newness).length;
    unseenCount = cd.comments.filter((comment) => comment.newness === 'unseen').length;
    if (newCount) {
      $nextButton.show();
      $previousButton.show();
      if (unseenCount) {
        $firstUnseenButton.show();
        this.updateFirstUnseenButton();
      }
    }
  },

  /**
   * Check if all comments on the page have been seen.
   *
   * @returns {boolean}
   */
  areAllCommentsSeen() {
    return unseenCount === 0;
  },

  /**
   * Update the unseen comments count without recounting.
   */
  decrementUnseenCommentCount() {
    unseenCount--;
  },

  /**
   * Update the state of the "Go to the first unseen comment" button.
   */
  updateFirstUnseenButton() {
    if (unseenCount) {
      $firstUnseenButton.text(unseenCount);
    } else {
      $firstUnseenButton.hide();
    }
  },

  /**
   * Perform routines at the refresh button click.
   */
  refreshClick() {
    // There was reload confirmation here, but after session restore was introduced, the
    // confirmation seems to be no longer needed.
    reloadPage({ commentAnchor: relevantNewCommentAnchor });
  },

  /**
   * Close all new comment notifications immediately.
   */
  closeAllNotifications() {
    notifications.forEach((notification) => {
      notification.notification.$notification.hide();
      notification.notification.close();
    });
    notifications = [];
  },

  /**
   * Scroll to the previous new comment.
   */
  goToPreviousNewComment() {
    if (cd.g.autoScrollInProgress) return;

    const foundComment = Comment.findInViewport('backward');
    if (!foundComment) return;

    const comment = reorderArray(cd.comments, foundComment.id, true)
      .find((comment) => comment.newness && comment.isInViewport(true) === false);
    if (comment) {
      comment.$elements.cdScrollTo('center', true, () => {
        comment.registerSeen('backward', true);
        this.updateFirstUnseenButton();
      });
    }
  },

  /**
   * Scroll to the next new comment.
   */
  goToNextNewComment() {
    if (cd.g.autoScrollInProgress) return;

    const foundComment = Comment.findInViewport('forward');
    if (!foundComment) return;

    const comment = reorderArray(cd.comments, foundComment.id)
      .find((comment) => comment.newness && comment.isInViewport(true) === false);
    if (comment) {
      comment.$elements.cdScrollTo('center', true, () => {
        comment.registerSeen('forward', true);
        this.updateFirstUnseenButton();
      });
    }
  },

  /**
   * Scroll to the first unseen comment.
   */
  goToFirstUnseenComment() {
    if (cd.g.autoScrollInProgress) return;

    if (unseenCount) {
      const comment = cd.comments
        .slice(lastFirstTimeSeenCommentId || 0)
        .find((comment) => comment.newness === 'unseen');
      if (comment) {
        comment.$elements.cdScrollTo('center', true, () => {
          comment.registerSeen('forward', true);
          this.updateFirstUnseenButton();
        });
        lastFirstTimeSeenCommentId = comment.id;
      }
    }
  },

  /**
   * Go to the next comment form out of sight.
   */
  goToCommentForm() {
    const commentForm = cd.commentForms
      .filter((commentForm) => !commentForm.$element.cdIsInViewport(true))
      .sort((commentForm1, commentForm2) => {
        const top1 = commentForm1.$element.get(0).getBoundingClientRect().top;
        const top2 = commentForm2.$element.get(0).getBoundingClientRect().top;
        if (top1 > top2) {
          return 1;
        } else if (top2 > top1) {
          return -1;
        } else {
          return 0;
        }
      })[0];
    if (commentForm) {
      commentForm.$element.cdScrollIntoView('center');
      commentForm.commentInput.focus();
    }
  },

  /**
   * Mark comments that are currently in the viewport as read.
   */
  registerSeenComments() {
    // Don't run this more than once in some period, otherwise the scrolling may be slowed down.
    // Also, wait before running, otherwise comments may be registered as seen after a press of Page
    // Down/Page Up.
    if (!unseenCount || cd.g.dontHandleScroll || cd.g.autoScrollInProgress) return;

    cd.g.dontHandleScroll = true;

    // One scroll in Chrome/Firefox with Page Up/Page Down takes a little less than 200ms, but 200ms
    // proved to be not enough, so we try 300ms.
    setTimeout(() => {
      cd.g.dontHandleScroll = false;

      const foundComment = Comment.findInViewport();
      if (!foundComment) return;

      const registerSeenIfInViewport = (comment) => {
        const isInViewport = comment.isInViewport(true);
        if (isInViewport) {
          comment.registerSeen();
        } else if (isInViewport === false) {
          // isInViewport could also be null.
          return true;
        }
      };

      // Back
      cd.comments
        .slice(0, foundComment.id)
        .reverse()
        .some(registerSeenIfInViewport);

      // Forward
      cd.comments
        .slice(foundComment.id)
        .some(registerSeenIfInViewport);

      this.updateFirstUnseenButton();
    }, 300);
  },

  /**
   * Update the "Go to the next comment form out of sight" button visibility.
   */
  updateCommentFormButton() {
    if (cd.g.autoScrollInProgress) return;

    if (cd.commentForms.some((commentForm) => !commentForm.$element.cdIsInViewport(true))) {
      $commentFormButton.show();
    } else {
      $commentFormButton.hide();
    }
  }
};

export default navPanel;

!function () {
    "use strict";

    // Module constants.
    const MODULE_NAME = 'InfiScroll';
    const DEFAULT_TRESHOLD = 0.5;
    const SCROLL_THROTTLE = 100;
    const LOAD_STYLES = Object.freeze({
        LOAD_INDIVIDUAL: 'single',
        LOAD_BATCHES: 'batches'
    });

    const OPTIONS = Object.freeze({
        TRESHOLD: 'treshold'            // Amount of pixels below the parent border which are deemed 'in view'.
                                        // Calculated as CHILD_SIZE * TRESHOLD.
        , ELEMENT_LIMIT: 'elementLimit' // Maximum list elements in DOM.
        , SIZE: 'size'                  // Size of the list.
        , QUERY: 'generator'            // Generator function.
        , FIXED_SIZE: 'fixedSize'       // Boolean indicating if the list should initially display full height.
        , CHILD_SIZE: 'childSize'       // Fixed height of a single list element.
        , CACHE_SIZE: 'cacheSize'
    });

    // Do not allow use in environments such as Node as it makes no sense.
    if (!window)
        throw new Error(`${MODULE_NAME} cannot be used in non-browser environment`);

    /**
     * Create range of numbers from start to start+N.
     *
     * @param start Starting index.
     * @param N Number of indices to generate.
     * @returns {Array} Array of range numbers.
     */
    function numRange(start, N) {
        return Array.from(Array(N || 1), (val, index) => start + index);
    }

    /**
     * Log warning message.
     *
     * @param {string} msg Message.
     */
    function warn(msg) {
        console.warn(`${MODULE_NAME}: ${msg}`);
    }

    /**
     * Return the indices of list items which fit into the list view.
     *
     * @param {number} rootTop Container view scrollTop.
     * @param {number} rootHeight Container height.
     * @param {number} treshold Extra treshold below the visible container.
     * @param {number} childSize Fixed size of a child container.
     */
    function getChildrenInView(rootTop, rootHeight, treshold, childSize) {
        const top = rootTop
            , totalHeight = rootHeight + treshold
            , firstChildInView = (top / childSize) >>> 0
            , firstChildExcess = firstChildInView * childSize
            , viewLeft = totalHeight - (firstChildExcess - rootTop)
            , childrenInView = Math.ceil(viewLeft / childSize);

        return numRange(firstChildInView, childrenInView);
    }

    /**
     * Generate DOM id property for given list item.
     *
     * @param {number} index Ordinal index of the child in list.
     * @returns {string} Generated id property.
     */
    function getListItemId(index) {
        return `__${MODULE_NAME}_index_${index}`;
    }

    /**
     * Remove given list items from DOM.
     *
     * @param {HTMLELement} parent DOM element containing children.
     * @param {number[]} elements Element ids to remove.
     * @return Map which maps element ids to removed DOM elements, for caching.
     */
    function removeChildren(parent, ...elements) {
        const result = new Map();
        elements.flat().forEach(e => {
            const childId = getListItemId(e);
            const elem = document.getElementById(childId);
            console.log("Removing child " + childId + " from DOM");
            result.set(e, elem);
            parent.removeChild(elem);
        });

        return result;
    }

    /**
     * Validate passed options for required arguments.
     *
     * @param {Object} object Options object.
     * @param {string[]} properties Required properties.
     */
    function requireOptions(object, ...properties) {
        const missing = properties.filter(p => !(p in object));
        if (missing.length)
            throw Error(`Options object is missing required properties ${missing}`);
    }

    /**
     * Position and modify the generated child DOM element.
     *
     * @param {number} index Ordinal index in the list.
     * @param {HTMLElement} elem Generated DOM element.
     * @param {boolean} finalElement True if the element is last in the list.
     */
    function addChild(index, elem, finalElement) {
        // Position the element absolutely according to its ordinal position.
        elem.style.position = 'absolute';
        elem.style.margin = 0;
        elem.style.top = `${index * this.__childSize}px`;
        elem.id = getListItemId(index);

        // Append the new child element to the containing div.
        this.element.appendChild(elem);

        // Stretch the view below last loaded element if not the last element.
        if (!finalElement) {
            this.__dummyElement.top = `${(index + 1) * this.__childSize + this.__treshold}px`;
            if (this.__dummyElement.parentNode)
                this.element.removeChild(this.__dummyElement);
            this.element.appendChild(this.__dummyElement);
        }
        /*        if (!this.__options.fixedSize && this.__options.scrollOnLoad === true) {
                    elem.scrollIntoView({
                        behavior: 'smooth',
                        block: 'end'
                    });
                }*/
    }

    function onListItemGenerated(index, newElement) {
        if (!this.__inView.has(index))
            return;

        // Validate returned new child element.
        if ((newElement === null || newElement === undefined))
            return;
        if (!(newElement instanceof HTMLElement))
            throw Error(`${MODULE_NAME} query callback resolved with non-HTMLElement result.`);

        this.__queries.delete(index);
        const lastItemInList = index === this.__size;
        addChild.call(this, index, newElement, lastItemInList);
    }

    /**
     * Constructor for a dynamically generated 'Infinite scroll' list.
     *
     * @param {HTMLElement} elem Element which will be turned into a scrollable list. Preferably DIV.
     * @param {Object} options Configuration for the list.
     * @constructor
     */
    function ScrollElement(elem, options) {
        // Validation
        if (!(elem instanceof HTMLElement))
            throw Error(`${elem} is not instance of HTMLElement`);

        this.element = elem;

        // The parent element has to have absolute or relative position property to allow children
        // to be placed relative to its constraints.
        const computedStyle = window.getComputedStyle(elem);
        if (!~(['absolute', 'relative'].indexOf(computedStyle.position)))
            throw Error(`${elem} must have position of 'absolute' or 'relative'`);

        if (!options)
            throw Error(`options argument must be passed to ${MODULE_NAME} constructor`);

        // Invalidate the list when window is resized.
        this.__resizeListener = () => {
            this.invalidate();
        };
        window.addEventListener('resize', this.__resizeListener);

        // Invalidate and recalculate the list when it's scrolled.
        // Throttle event firing to avoid needless computation.
        let scrollTimeout = null;
        this.__scrollListener = () => {
            if (scrollTimeout !== null) {
                clearTimeout(scrollTimeout);
            }
            scrollTimeout = setTimeout(() => {
                this.invalidate();
                scrollTimeout = null;
            }, SCROLL_THROTTLE);
        };
        elem.addEventListener('scroll', this.__scrollListener);

        // Clear the container.
        while (this.element.firstChild)
            this.element.removeChild(this.element.firstChild);

        // Inner state.
        this.__children = new Set(); // All loaded children.
        this.__inView = new Set();   // List items in view currently.
        this.__queue = [];           // Queue to determine which elements to remove from DOM.
        this.__cacheQueue = [];      // Queue to determine which elements to remove form cache.
        this.__cache = new Map();    // Cached DOM elements.
        this.__queries = new Set();  // Ongoing unresolved queries for new elements.

        // Handle passed options.
        requireOptions(options, OPTIONS.QUERY, OPTIONS.CHILD_SIZE);
        this.__query = options[OPTIONS.QUERY];
        this.__childSize = options[OPTIONS.CHILD_SIZE];
        this.__fixedSize = options[OPTIONS.FIXED_SIZE];
        this.__size = options[OPTIONS.SIZE];
        this.__elementLimit = options[OPTIONS.ELEMENT_LIMIT];
        this.__cacheSize = options[OPTIONS.CACHE_SIZE];
        this.__treshold = (OPTIONS.TRESHOLD in options
            ? options[OPTIONS.TRESHOLD]
            : DEFAULT_TRESHOLD)
            * options.childSize;

        !function() {
            const extraKeys = Object.keys(options).filter(k => !~Object.values(OPTIONS).indexOf(k));
            if (extraKeys.length)
                warn(`Options object contained invalid options '${extraKeys}'. Typos?`);
        }();

        // Create 'dummy' div element which is used to handle the scroll height.
        const dummy = document.createElement('div');
        dummy.style.height = dummy.style.width = 0;
        dummy.style.visibility = 'none';
        dummy.style.position = 'absolute';
        this.__dummyElement = dummy;

        // Create dummy element to stretch the container to full height on load.
        if (this.__fixedSize === true) {
            dummy.style.top = `${this.__childSize * (this.__size + 1)}px`;
            this.element.appendChild(dummy);
        }

        // Initial refresh
        setTimeout(() => this.invalidate(), 0);
    }

    ScrollElement.prototype.reload = function() {
        removeChildren(this.element, Array.from(this.__children));
        this.__children.clear();
        this.__inView.clear();
        this.__dummyElement.top = 0;
        this.invalidate();
    };

    ScrollElement.prototype.invalidate = function () {
        const scrollTop = this.element.scrollTop;
        const height = this.element.clientHeight;

        // Calculate which elements are in the view or inside treshold.
        const elementsInView = getChildrenInView(scrollTop, height, this.__treshold, this.__childSize);
        // Calculate set difference; which elements should be loaded.
        const difference = elementsInView.filter(e => !this.__children.has(e));

        this.__inView = new Set(elementsInView);
        difference.forEach(e => this.__queue.push(e));

        elementsInView.forEach(e => this.__children.add(e));
        if (this.__elementLimit) {
            const elementsToRemove = [];
            let i = 0;
            while (this.__queue.length > this.__elementLimit && i++ < this.__queue.length) {
                const candidateForRemoval = this.__queue.shift();
                if (this.__inView.has(candidateForRemoval) || this.__queries.has(candidateForRemoval))
                    continue;
                elementsToRemove.push(candidateForRemoval);
            }

            if (elementsToRemove.length) {
                setTimeout(() => {
                    const removedElements = removeChildren(this.element, elementsToRemove)
                    for (const [removedId, removedDom] of removedElements.entries()) {
                        this.__cacheQueue.push(removedId);
                        this.__cache.set(removedId, removedDom);
                        this.__children.delete(removedId);
                    }

                    console.log(this.__cacheQueue);

                    while (this.__cacheSize && this.__cacheQueue.length > this.__cacheSize) {
                        const removeCachedId = this.__cacheQueue.shift();
                        this.__cache.delete(removeCachedId);
                        console.log('removed from cache ' + removeCachedId);
                    }
                }, 0);
            }
        }

        // Generate required list elements.
        for (const childToQuery of difference) {
            // Do not attempt to load elements past the fixed size.
            if (this.__size && childToQuery > this.__size)
                continue;

            // Do not invoke generator if query is unresolved already.
            if (!this.__queries.has(childToQuery)) {
                // Check if the DOM element has already been generated and cached.
                if (this.__cache.has(childToQuery)) {
                    console.log('got ' + childToQuery + ' from cache');
                    onListItemGenerated.call(this, childToQuery, this.__cache.get(childToQuery))
                    this.__cache.delete(childToQuery);
                    this.__cacheQueue.splice(this.__cacheQueue.indexOf(childToQuery), 1)
                } else {
                    this.__query(childToQuery, newElement => onListItemGenerated.call(this, childToQuery, newElement));
                }
            }

            this.__children.add(childToQuery);
        }
    };

    /**
     * Add a new list item.
     *
     * @param {HtmlElement} elem HTML element to append to the scrollable list.
     */
    ScrollElement.prototype.addItem = function (generator) {
        if (!(generator instanceof HTMLElement))
            throw new Error(`Argument is not a HTMLElement`);
    };

    ScrollElement.prototype.dispose = function () {
        window.removeEventListener('resize', this.__resizeListener);
        this.element.removeEventListener('scroll', this.__scrollListener);
    };

    // Bind as global function
    if (MODULE_NAME in window)
        throw new Error(`CLASH: Global property ${MODULE_NAME} exist already in window!`);
    window[MODULE_NAME] = ScrollElement;
}();
import React, {
	PropsWithChildren,
	ReactElement,
	useState,
	useRef,
	useEffect,
	useCallback,
	useMemo,
	useLayoutEffect,
} from 'react';
import {
	ListRenderItemInfo,
	NativeScrollEvent,
	NativeSyntheticEvent,
	FlatList,
	Animated,
	findNodeHandle,
	StyleSheet,
	LayoutAnimation,
	View,
	Platform,
} from 'react-native';

import { DraxView } from './DraxView';
import { DraxSubprovider } from './DraxSubprovider';
import { useDraxContext, useDraxId } from './hooks';
import {
	DraxListProps,
	DraxMonitorEventData,
	AutoScrollDirection,
	Position,
	DraxViewMeasurements,
	DraxMonitorDragDropEventData,
	DraxMonitorEndEventData,
	DraxViewRegistration,
	DraxProtocolDragEndResponse,
	DraxSnapbackTargetPreset,
	isWithCancelledFlag,
} from './types';
import { defaultListItemLongPressDelay } from './params';

interface Shift {
	targetValue: number;
	animatedValue: Animated.Value;
}

interface ListItemPayload {
	index: number;
	originalIndex: number;
}

const defaultStyles = StyleSheet.create({
	draggingStyle: { opacity: 0 },
	dragReleasedStyle: { opacity: 0 },
});

export const DraxList = <T extends unknown>({
	data,
	style,
	itemStyles,
	renderItemContent,
	renderItemHoverContent,
	onItemDragStart,
	onItemDragPositionChange,
	onItemDragEnd,
	onItemReorder,
	id: idProp,
	reorderable: reorderableProp,
	// @ts-ignore
	onChangeList,
	// @ts-ignore
	dummyItem,
	...props
}: PropsWithChildren<DraxListProps<T>>): ReactElement | null => {
	// Copy the value of the horizontal property for internal use.
	const { horizontal = false } = props;
	// grab context for snapback in a nested list
	const { parent: contextParent, getTrackingDragged } = useDraxContext();
	const {
		containerScrollPosition,
		dragExitedContainer,
		containerAutoScrollId,
	} = contextParent ?? {};
	// Whether or not to visibly show the dummy item (only want to show on hover from alien tile)
	const [showDummy, setShowDummy] = useState(false);
	// Set a sensible default for reorderable prop.
	const reorderable = reorderableProp ?? onItemReorder !== undefined;
	// The unique identifer for this list's Drax view.
	const id = useDraxId(idProp);
	// FlatList, used for scrolling.
	const flatListRef = useRef<FlatList<T> | null>(null);
	// FlatList node handle, used for measuring children.
	const nodeHandleRef = useRef<number | null>(null);
	// Container view measurements, for scrolling by percentage.
	const containerMeasurementsRef = useRef<DraxViewMeasurements | undefined>(
		undefined
	);
	// Content size, for scrolling by percentage.
	const contentSizeRef = useRef<Position | undefined>(undefined);
	// Scroll position, for Drax bounds checking and auto-scrolling.
	const scrollPositionRef = useRef<Position>({ x: 0, y: 0 });
	// Original index of the currently dragged list item, if any.
	const draggedItemRef = useRef<number | undefined>(undefined);
	// Auto-scrolling state.
	const scrollStateRef = useRef(AutoScrollDirection.None);
	// Auto-scrolling interval.
	const scrollIntervalRef = useRef<NodeJS.Timeout | undefined>(undefined);
	// List item measurements, for determining shift.
	const itemMeasurementsRef = useRef<(DraxViewMeasurements | undefined)[]>([]);
	// Drax view registrations, for remeasuring after reorder.
	const registrationsRef = useRef<(DraxViewRegistration | undefined)[]>([]);
	// Shift offsets.
	const shiftsRef = useRef<Shift[]>([]);
	// Maintain cache of reordered list indexes until data updates.
	const [originalIndexes, setOriginalIndexes] = useState<number[]>([]);
	// Maintain the index the item is currently dragged to.
	const draggedToIndex = useRef<number | undefined>(undefined);
	// Maintain the dimensions of the last dragged item from another DraxList.
	const [dummyItemDimensions, setDummyItemDimensions] = useState<{
		height: number;
		width: number;
	}>();
	// Used to imperatively control scroll bar for android
	const [scrollTo, setScrollTo] = useState<'start' | 'end' | undefined>(
		undefined
	);

	// if dummyItem prop is true, then append an object to our data array
	const dataUpdated = useMemo(() => {
		// @ts-ignore
		return dummyItem ? [...data, { id: 100000 }] : data;
	}, [data, dummyItem]);

	// Get the item count for internal use.
	const itemCount = dataUpdated?.length ?? 0;

	// Android only, bug fix: imperatively control scroll bar when last item is visibly moved
	useEffect(() => {
		if (scrollTo && Platform.OS === 'android') {
			if (scrollTo === 'end') {
				flatListRef.current!.scrollToEnd({ animated: true });
			} else if (scrollTo === 'start') {
				flatListRef.current!.scrollToIndex({ index: 0 });
			}
		}
	}, [itemCount, scrollTo, showDummy]);

	// Adjust measurements, registrations, and shift value arrays as item count changes.
	useEffect(() => {
		// reset state variable for android imperative scroll bux-fix
		setScrollTo(undefined);
		// if # of items have changed, setShowDummy false (covers reset on success cases)
		setShowDummy(false);
		const itemMeasurements = itemMeasurementsRef.current;
		const registrations = registrationsRef.current;
		const shifts = shiftsRef.current;
		if (itemMeasurements.length > itemCount) {
			itemMeasurements.splice(itemCount - itemMeasurements.length);
			registrations.splice(itemCount - registrations.length);
			shifts.splice(itemCount - shifts.length);
		} else {
			while (itemMeasurements.length < itemCount) {
				itemMeasurements.push(undefined);
				registrations.push(undefined);
				shifts.push({
					targetValue: 0,
					animatedValue: new Animated.Value(0),
				});
			}
		}
	}, [itemCount]);

	// update the dummyItemDimensions ref upon receiving a drag of a DraxView belonging to another DraxList
	useEffect(() => {
		if (!showDummy) {
			const newData = { height: 0, width: 0 };
			// console.log('dummy item dimensions updated', newData)
			setDummyItemDimensions(newData);
		}
		// grab the currently dragged item in the entire system from context
		const draggedItem = getTrackingDragged();
		const draggedItemMeasurements = draggedItem?.data.absoluteMeasurements;
		// this way, our value won't become undefined the moment a DraxView is released from drag. gets us dimensions of last dragged DraxView.
		if (draggedItemMeasurements) {
			const newData = {
				height: draggedItemMeasurements.height,
				width: draggedItemMeasurements.width,
			};
			// console.log('dummy item dimensions updated', newData)
			setDummyItemDimensions(newData);
		}
	}, [showDummy, getTrackingDragged]);

	// Clear reorders when data changes.
	useLayoutEffect(() => {
		// console.log('clear reorders');
		setOriginalIndexes(
			dataUpdated ? [...Array(dataUpdated.length).keys()] : []
		);
	}, [dataUpdated]);

	// Apply the reorder cache to the data.
	const reorderedData = useMemo(() => {
		// console.log('refresh sorted data');
		if (!id || !dataUpdated) {
			return null;
		}
		if (dataUpdated.length !== originalIndexes.length) {
			return dataUpdated;
		}
		return originalIndexes.map((index) => dataUpdated[index]);
	}, [id, dataUpdated, originalIndexes]);

	// Get shift transform for list item at index.
	const getShiftTransform = useCallback(
		(index: number) => {
			const shift = shiftsRef.current[index]?.animatedValue ?? 0;
			return horizontal ? [{ translateX: shift }] : [{ translateY: shift }];
		},
		[horizontal]
	);

	// Set the currently dragged list item.
	const setDraggedItem = useCallback((originalIndex: number) => {
		draggedItemRef.current = originalIndex;
	}, []);

	// Clear the currently dragged list item.
	const resetDraggedItem = useCallback(() => {
		draggedItemRef.current = undefined;
	}, []);

	const shiftBeforeListShrinks = useCallback(
		(displacedIndex) => {
			if (displacedIndex >= 0) {
				const scrollPosition = horizontal
					? scrollPositionRef.current.x
					: scrollPositionRef.current.y;
				// console.log('scrollPosition:', scrollPosition);
				const contentLength = horizontal
					? contentSizeRef.current!.x
					: contentSizeRef.current!.y;
				const containerLength = horizontal
					? containerMeasurementsRef.current!.width
					: containerMeasurementsRef.current!.height;
				const itemSizes = itemMeasurementsRef.current;
				const lastItemPosition = itemSizes[itemCount - 1 - dummyItem]!.x;
				const lastItemVisible =
					scrollPosition + containerLength >= lastItemPosition;

				const displacedLength = horizontal
					? itemSizes[displacedIndex]!.width
					: itemSizes[displacedIndex]!.height;

				// these shifts are used in cases 2a-iii & 3a,
				// where last item is visible & removing item won't reduce contentSize to <= one container
				// this algorithm splits the displaced width in two: one for rightList, rest for leftList
				const rightListShift = scrollPosition + containerLength - contentLength;
				const leftListShift = rightListShift + displacedLength;

				originalIndexes.forEach((originalIndex, index) => {
					const shift = shiftsRef.current[originalIndex];
					let newTargetValue = 0;

					// where scrollPosition is 0
					if (scrollPosition === 0) {
						// console.log('case 1');
						if (index > displacedIndex) {
							newTargetValue = -displacedLength;
						}
					}
					// else: scrollPosition > 0
					else {
						// if scrollPosition is less than displacedLength (but greater than 0)
						if (scrollPosition < displacedLength) {
							// if we cannot see last item, then maintain scrollPosition
							if (!lastItemVisible) {
								// console.log('case 2a-i');
								// maintain scrollPosition by shifting rightPartition left
								if (index > displacedIndex) {
									newTargetValue = -displacedLength;
								}
							}
							// if removing the item means our total content will be <= one container, dual shift
							else if (contentLength - displacedLength <= containerLength) {
								if (Platform.OS === 'ios') {
									// console.log('case 2a-ii ios');
									// if right of displaced tile, move left
									if (index > displacedIndex) {
										newTargetValue = -displacedLength + scrollPosition;
									}
									// if left of displaced tile, move right
									if (index < displacedIndex) {
										newTargetValue = scrollPosition;
									}
								}
								// if Android
								else {
									// console.log('case 2a-ii android');
									// if right of displaced tile, move left
									if (index > displacedIndex) {
										newTargetValue = -displacedLength;
										if (index === itemCount - 1) {
											setScrollTo('start');
										}
									}
								}
							}
							// if we can see last item, and removing the displaced item won't reduce contentSize to <= one container
							else {
								if (Platform.OS === 'ios') {
									// console.log('case 2a-iii ios');
									// dual shifts must offset displacedLength
									// if right of displaced tile, move left
									if (index > displacedIndex) {
										newTargetValue = rightListShift;
									}
									// if left of displaced tile, move right
									if (index < displacedIndex) {
										newTargetValue = leftListShift;
									}
								} else {
									// console.log('case 2a-iii android');
									if (index > displacedIndex) {
										newTargetValue = -displacedLength;
									}
									if (index === itemCount - 1) {
										setScrollTo('end');
									}
								}
							}
						}
						// where scrollPosition > displacedLength
						else {
							// if we can see the last item, dual shift
							if (lastItemVisible) {
								if (Platform.OS === 'ios') {
									// console.log('case 3a ios');
									// dual shifts must offset displacedLength
									if (index > displacedIndex) {
										newTargetValue = rightListShift;
									}
									if (index < displacedIndex) {
										newTargetValue = leftListShift;
									}
								} else {
									// console.log('case 3a android');
									if (index > displacedIndex) {
										newTargetValue = -displacedLength;
									}
									if (index === itemCount - 1) {
										contentLength - displacedLength > containerLength
											? setScrollTo('end')
											: setScrollTo('start');
									}
								}
							} else {
								// if we can't see last item, and scrollPosition > displacement
								// if right of displaced tile, move left
								// console.log('case 3b');
								if (index > displacedIndex) {
									newTargetValue = -displacedLength;
								}
							}
						}
					}
					if (shift.targetValue !== newTargetValue) {
						shift.targetValue = newTargetValue;
						Animated.timing(shift.animatedValue, {
							duration: 300,
							toValue: newTargetValue,
							useNativeDriver: true,
						}).start();
					}
				});
			}
		},
		[
			originalIndexes,
			scrollPositionRef,
			contentSizeRef,
			containerMeasurementsRef,
			itemMeasurementsRef,
			shiftsRef,
			dummyItem,
			horizontal,
			itemCount,
		]
	);

	// animation to hideDummy smoothly. triggered when item enters this list and then exits.
	const hideDummy = useCallback(() => {
		if (Platform.OS === 'android') {
			const contentLength = horizontal
				? contentSizeRef.current!.x
				: contentSizeRef.current!.y;
			const containerLength = horizontal
				? containerMeasurementsRef.current!.width
				: containerMeasurementsRef.current!.height;

			contentLength > containerLength
				? setScrollTo('end')
				: setScrollTo('start');
			setShowDummy(false);
			return;
		} else {
			const animation = LayoutAnimation.create(
				250,
				LayoutAnimation.Types.easeInEaseOut,
				LayoutAnimation.Properties.opacity
			);
			LayoutAnimation.configureNext(animation);
			setShowDummy(false);
		}
	}, [horizontal]);

	const handleDragEnd = useCallback(() => {
		// console.log('resetting interval id', containerAutoScrollId)
		// if user's finger left vertical scrollview, we must clearInterval here onDragEnd
		if (containerAutoScrollId) {
			clearInterval(containerAutoScrollId);
		}
		resetDraggedItem();
	}, [containerAutoScrollId, resetDraggedItem]);

	const handleDragDrop = useCallback(
		(eventData, index) => {
			// onMonitorDrop: same list => calls resetShifts immediately, diff list => calls resetShifts only once toList's animation finishes
			// thus, shiftBeforeListShrinks only has effect on btw list move, executing while toList is animating
			// first, check if user's finger is within vertical ScrollView
			if (dragExitedContainer) {
				return; // if not, then not a valid drop
			}
			// if this item is dropped into same parent, no work necessary
			if (eventData.dragged.parentId === eventData.receiver.parentId) {
				return;
			}

			shiftBeforeListShrinks(index);
			resetDraggedItem();
		},
		[dragExitedContainer, shiftBeforeListShrinks, resetDraggedItem]
	);

	// depends on whether list is horizontal or vertical
	const renderDummyItem = useMemo(() => {
		const containerLength = horizontal
			? containerMeasurementsRef.current?.width ?? 0
			: containerMeasurementsRef.current?.height ?? 0;
		const contentLength = horizontal
			? contentSizeRef.current?.x ?? 0
			: contentSizeRef.current?.y ?? 0;
		const secondaryDimension = horizontal
			? contentSizeRef.current?.y ?? 0
			: contentSizeRef.current?.x ?? 0;

		const itemLength = horizontal
			? dummyItemDimensions?.width ?? 0
			: dummyItemDimensions?.height ?? 0;

		//#region
		// dummyItem's length should be a minimum of dragged item's length, & maximum of containerLength
		// if no other items, then dummyItem should fill entire device length, so dragging an item from elsewhere
		// into this day is guaranteed to work. ditto for one item, should fill up rest of length.
		////#endregion
		let length;
		// console.log('content', id, 'length:', contentLength)
		if (itemCount - 1 > 0) {
			let trueContentLength = contentLength;
			if (dummyItem) {
				trueContentLength =
					trueContentLength -
					(itemMeasurementsRef.current[itemCount - 1]?.width ?? 0);
				// console.log('trueContentLength:', trueContentLength)
			}
			length = Math.max(containerLength - trueContentLength, itemLength);
		} else {
			length = containerLength;
		}

		const primaryDimension = showDummy ? length : 0;
		const style = horizontal
			? { height: secondaryDimension, width: primaryDimension }
			: { height: primaryDimension, width: secondaryDimension };
		// console.log('id', id, 'dummyLength:', length)
		return <View style={style}></View>;
	}, [
		horizontal,
		dummyItem,
		itemCount,
		containerMeasurementsRef,
		contentSizeRef,
		dummyItemDimensions,
		showDummy,
	]);

	const renderItem = useCallback(
		(info: ListRenderItemInfo<T>) => {
			const { index } = info;
			const originalIndex = originalIndexes[index];
			const dummy = dummyItem && index === itemCount - 1;
			const {
				style: itemStyle,
				draggingStyle = defaultStyles.draggingStyle,
				dragReleasedStyle = defaultStyles.dragReleasedStyle,
				...otherStyleProps
			} = itemStyles ?? {};
			return (
				<DraxView
					style={[itemStyle, { transform: getShiftTransform(originalIndex) }]}
					draggable={!dummy}
					draggingStyle={draggingStyle}
					dragReleasedStyle={dragReleasedStyle}
					{...otherStyleProps}
					payload={{ index, originalIndex }}
					onDragEnd={handleDragEnd}
					onDragDrop={(eventData) => handleDragDrop(eventData, originalIndex)}
					onMeasure={(measurements) => {
						// console.log(`measuring [${index}, ${originalIndex}]: (${measurements?.x}, ${measurements?.y})`);
						itemMeasurementsRef.current[originalIndex] = measurements;
					}}
					registration={(registration) => {
						if (registration) {
							// console.log(`registering [${index}, ${originalIndex}], ${registration.id}`);
							registrationsRef.current[originalIndex] = registration;
							registration.measure();
						}
					}}
					renderContent={(contentProps) =>
						dummy ? renderDummyItem : renderItemContent(info, contentProps)
					}
					renderHoverContent={
						renderItemHoverContent &&
						((hoverContentProps) =>
							renderItemHoverContent(info, hoverContentProps))
					}
					longPressDelay={defaultListItemLongPressDelay}
				/>
			);
		},
		[
			originalIndexes,
			getShiftTransform,
			itemStyles,
			renderItemContent,
			renderItemHoverContent,
			dummyItem,
			itemCount,
			handleDragEnd,
			handleDragDrop,
			renderDummyItem,
		]
	);

	// Track the size of the container view.
	const onMeasureContainer = useCallback(
		(measurements: DraxViewMeasurements | undefined) => {
			containerMeasurementsRef.current = measurements;
		},
		[]
	);

	// Track the size of the content.
	const onContentSizeChange = useCallback((width: number, height: number) => {
		contentSizeRef.current = { x: width, y: height };
	}, []);

	// Set FlatList and node handle refs.
	const setFlatListRefs = useCallback((ref) => {
		flatListRef.current = ref;
		nodeHandleRef.current = ref && findNodeHandle(ref);
	}, []);

	// Update tracked scroll position when list is scrolled.
	const onScroll = useCallback(
		({
			nativeEvent: { contentOffset },
		}: NativeSyntheticEvent<NativeScrollEvent>) => {
			scrollPositionRef.current = { ...contentOffset };
		},
		[]
	);

	// Handle auto-scrolling on interval.
	const doScroll = useCallback(() => {
		const flatList = flatListRef.current;
		const containerMeasurements = containerMeasurementsRef.current;
		const contentSize = contentSizeRef.current;
		if (!flatList || !containerMeasurements || !contentSize) {
			return;
		}
		let containerLength: number;
		let contentLength: number;
		let prevOffset: number;
		if (horizontal) {
			containerLength = containerMeasurements.width;
			contentLength = contentSize.x;
			prevOffset = scrollPositionRef.current.x;
		} else {
			containerLength = containerMeasurements.height;
			contentLength = contentSize.y;
			prevOffset = scrollPositionRef.current.y;
		}
		const jumpLength = containerLength * 0.2;
		let offset: number | undefined;
		if (scrollStateRef.current === AutoScrollDirection.Forward) {
			const maxOffset = contentLength - containerLength;
			if (prevOffset < maxOffset) {
				offset = Math.min(prevOffset + jumpLength, maxOffset);
			}
		} else if (scrollStateRef.current === AutoScrollDirection.Back) {
			if (prevOffset > 0) {
				offset = Math.max(prevOffset - jumpLength, 0);
			}
		}
		if (offset !== undefined) {
			flatList.scrollToOffset({ offset });
			flatList.flashScrollIndicators();
		}
	}, [horizontal]);

	// Start the auto-scrolling interval.
	const startScroll = useCallback(() => {
		if (scrollIntervalRef.current) {
			return;
		}
		doScroll();
		scrollIntervalRef.current = setInterval(doScroll, 250);
	}, [doScroll]);

	// Stop the auto-scrolling interval.
	const stopScroll = useCallback(() => {
		if (scrollIntervalRef.current) {
			clearInterval(scrollIntervalRef.current);
			scrollIntervalRef.current = undefined;
		}
	}, []);

	// If startScroll changes, refresh our interval.
	useEffect(() => {
		if (scrollIntervalRef.current) {
			stopScroll();
			startScroll();
		}
	}, [stopScroll, startScroll]);

	// Reset all shift values.
	const resetShifts = useCallback((delay?: number) => {
		shiftsRef.current.forEach((shift) => {
			// eslint-disable-next-line no-param-reassign
			shift.targetValue = 0;
			if (!delay) {
				shift.animatedValue.setValue(shift.targetValue);
			} else {
				Animated.timing(shift.animatedValue, {
					duration: delay,
					toValue: shift.targetValue,
					useNativeDriver: true,
				}).start();
			}
		});
	}, []);

	// reset shifts on change to data
	useEffect(() => {
		resetShifts();
	}, [data, resetShifts]);

	// Update shift values in response to a drag.
	const updateShifts = useCallback(
		(draggedInfo, receiverPayload) => {
			const {
				draggedPayload,
				draggedParentId,
				width = 140,
				height = 90,
			} = draggedInfo;
			const fromIndex = draggedPayload?.index;
			const toIndex = receiverPayload?.index;

			const offset = horizontal ? width : height;

			originalIndexes.forEach((originalIndex, index) => {
				const shift = shiftsRef.current[originalIndex];
				let newTargetValue = 0;
				// dragged item from other list
				if (draggedParentId !== id) {
					// if receiverPayload defined, move ToList's items right of receiving index rightwards
					if (receiverPayload && index >= toIndex) {
						newTargetValue = offset;
					}
				}
				// dragged item belongs to this list
				else {
					// items between dragged and received index should shift leftwards
					if (index > fromIndex && index <= toIndex) {
						newTargetValue = -offset;
					}
					// items between received index and dragged should shift rightwards
					else if (index < fromIndex && index >= toIndex) {
						newTargetValue = offset;
					}
				}
				if (shift.targetValue !== newTargetValue) {
					shift.targetValue = newTargetValue;
					Animated.timing(shift.animatedValue, {
						duration: 200,
						toValue: newTargetValue,
						useNativeDriver: true,
					}).start();
				}
			});
		},
		[originalIndexes, horizontal, id]
	);

	// Calculate absolute position of list item for snapback.
	const calculateSnapbackTarget = useCallback(
		(draggedInfo, receiverPayload) => {
			const { draggedPayload, draggedParentId } = draggedInfo;

			const {
				index: fromIndex,
				originalIndex: fromOriginalIndex,
			} = draggedPayload;
			const toIndex = receiverPayload?.index;
			const toOriginalIndex = receiverPayload.originalIndex;

			const containerMeasurements = containerMeasurementsRef.current;
			const itemMeasurements = itemMeasurementsRef.current;

			if (containerMeasurements) {
				let targetPos: Position | undefined;

				if (draggedParentId === id && fromIndex < toIndex) {
					// Target pos(toIndex + 1) - pos(fromIndex)
					const nextIndex = toIndex + 1;
					let nextPos: Position | undefined;
					if (nextIndex < itemCount) {
						// toIndex + 1 is in the list. We can measure the position of the next item.
						const nextMeasurements =
							itemMeasurements[originalIndexes[nextIndex]];
						if (nextMeasurements) {
							nextPos = {
								x: nextMeasurements.x,
								y: nextMeasurements.y,
							};
						}
					} else {
						// toIndex is the last item of the list. We can use the list content size.
						const contentSize = contentSizeRef.current;
						if (contentSize) {
							nextPos = horizontal
								? { x: contentSize.x, y: 0 }
								: { x: 0, y: contentSize.y };
						}
					}
					const fromMeasurements = itemMeasurements[fromOriginalIndex];
					if (nextPos && fromMeasurements) {
						targetPos = horizontal
							? {
									x: nextPos.x - fromMeasurements.width,
									y: nextPos.y,
							  }
							: {
									x: nextPos.x,
									y: nextPos.y - fromMeasurements.height,
							  };
					}
				} else {
					// Target pos(toIndex)
					const toMeasurements = itemMeasurements[toOriginalIndex];
					if (toMeasurements) {
						targetPos = {
							x: toMeasurements.x,
							y: toMeasurements.y,
						};
					}
				}

				if (targetPos) {
					const scrollPosition = scrollPositionRef.current;
					// console.log('scroll position x: ', scrollPosition.x)
					// console.log('scroll position y: ', scrollPosition.y)
					// if this DraxList is within another scroll, then we need that scroll's position too.
					const { x, y } = containerScrollPosition ?? { x: 0, y: 0 };
					// console.log('parent scroll position y:', y)
					return {
						x: containerMeasurements.x - scrollPosition.x - x + targetPos.x,
						y: containerMeasurements.y - scrollPosition.y - y + targetPos.y,
					};
				}
			}
			return DraxSnapbackTargetPreset.None;
		},
		[horizontal, itemCount, originalIndexes, id, containerScrollPosition]
	);

	// Stop auto-scrolling, and potentially update shifts and reorder data.
	const handleInternalDragEnd = useCallback(
		(
			eventData:
				| DraxMonitorEventData
				| DraxMonitorEndEventData
				| DraxMonitorDragDropEventData,
			totalDragEnd: boolean
		): DraxProtocolDragEndResponse => {
			// Always stop auto-scroll on drag end.
			scrollStateRef.current = AutoScrollDirection.None;
			stopScroll();

			const { dragged, receiver, draggedDimensions } = eventData;

			// first, check if user's finger exited vertical ScrollView. If it has, then this is not a valid drop.
			if (dragExitedContainer) {
				setShowDummy(false);
				resetShifts(200);
				return undefined;
			}

			// if dragged item comes from other parent
			if (reorderable && dragged.parentId !== id) {
				draggedToIndex.current = undefined;
				if (receiver && totalDragEnd) {
					// prepare argument object
					const draggedInfo = {
						draggedPayload: dragged.payload,
						draggedParentId: dragged.parentId,
						...draggedDimensions,
					};
					// if user swipes an item into the list without hovering over, ensure shift occurs:
					if (shiftsRef.current[receiver.payload.index].targetValue === 0) {
						updateShifts(draggedInfo, receiver?.payload);
					}
					// compute target to snap back to
					const snapbackTarget = calculateSnapbackTarget(
						draggedInfo,
						receiver.payload
					);

					if (dataUpdated) {
						const newOriginalIndexes = originalIndexes.slice();
						newOriginalIndexes.splice(receiver.payload.index, 0);
						setOriginalIndexes(newOriginalIndexes);
					}

					// return value is supplied to context method resetDrag, which animates tile to target
					// & calls callback once animation completes (which updates state)
					return {
						target: snapbackTarget,
						callback: () => {
							resetShifts(); // don't want to reset shifts until after snapback animation completes
							onChangeList(
								dragged.payload.originalIndex,
								receiver.payload.originalIndex,
								dragged.parentId,
								id
							);
						},
					};
				} else {
					// either receiver is undefined or totalDragEnd is false
					// if drag belongs to another parent & leaves this DraxList, simply resetShifts(200)
					hideDummy(); // hides our dummy item, since we only want to show when its being hovered over
					resetShifts(200);
				}
			}

			// if dragged item comes from this list's parent
			if (reorderable && dragged.parentId === id) {
				// Determine list indexes of dragged/received items, if any.
				const fromPayload = dragged.payload as ListItemPayload;
				const toPayload =
					receiver?.parentId === id
						? (receiver.payload as ListItemPayload)
						: undefined;

				const {
					index: fromIndex,
					originalIndex: fromOriginalIndex,
				} = fromPayload;
				const { index: toIndex, originalIndex: toOriginalIndex } =
					toPayload ?? {};
				const toItem =
					toOriginalIndex !== undefined
						? dataUpdated?.[toOriginalIndex]
						: undefined;

				if (totalDragEnd) {
					onItemDragEnd?.({
						...eventData,
						toIndex,
						toItem,
						cancelled: isWithCancelledFlag(eventData)
							? eventData.cancelled
							: false,
						index: fromIndex,
						item: dataUpdated?.[fromOriginalIndex],
					});
				}

				// Reset currently dragged over position index to undefined.
				if (draggedToIndex.current !== undefined) {
					if (!totalDragEnd) {
						onItemDragPositionChange?.({
							...eventData,
							index: fromIndex,
							item: dataUpdated?.[fromOriginalIndex],
							toIndex: undefined,
							previousIndex: draggedToIndex.current,
						});
					}
					draggedToIndex.current = undefined;
				}

				// if drag is existing member of this list, and it's receiver is defined, then:
				if (toPayload !== undefined) {
					// prepare argument object
					const draggedInfo = {
						draggedPayload: dragged.payload,
						draggedParentId: dragged.parentId,
						...draggedDimensions,
					};
					const snapbackTarget = calculateSnapbackTarget(
						draggedInfo,
						toPayload
					);
					if (dataUpdated) {
						const newOriginalIndexes = originalIndexes.slice();
						newOriginalIndexes.splice(
							toIndex!,
							0,
							newOriginalIndexes.splice(fromIndex, 1)[0]
						);
						// console.log('SET ORIGINAL INDEXES!')
						setOriginalIndexes(newOriginalIndexes);
						onItemReorder?.({
							fromIndex,
							fromItem: dataUpdated[fromOriginalIndex],
							toIndex: toIndex!,
							toItem: dataUpdated[toOriginalIndex!],
						});
					}
					return { target: snapbackTarget };
				} else {
					// dragged.parentId === id && toPayload is undefined
					// either tile is being dragged out of parent (TDE=false) or dropped back into parent (TDE=true)
					if (!totalDragEnd) {
						// console.log('DraxView left this monitor, id:', id)
						resetShifts(200);
					}
				}
			}
			return undefined;
		},
		[
			id,
			stopScroll,
			reorderable,
			resetShifts,
			calculateSnapbackTarget,
			originalIndexes,
			onItemDragEnd,
			onItemDragPositionChange,
			onItemReorder,
			onChangeList,
			dragExitedContainer,
			dataUpdated,
			hideDummy,
			updateShifts,
		]
	);

	// Monitor drag starts to handle callbacks.
	const onMonitorDragStart = useCallback(
		(eventData: DraxMonitorEventData) => {
			// console.log('\n', 'onMonitorDragStart id:', id, '\n')
			const { dragged } = eventData;
			// First, check if we need to do anything.
			if (reorderable && dragged.parentId === id) {
				// One of our list items is starting to be dragged.
				const { index, originalIndex }: ListItemPayload = dragged.payload;
				setDraggedItem(originalIndex);
				onItemDragStart?.({
					...eventData,
					index,
					item: dataUpdated?.[originalIndex],
				});
			}
		},
		[id, reorderable, dataUpdated, setDraggedItem, onItemDragStart]
	);

	// Monitor drags to react with item shifts and auto-scrolling.
	const onMonitorDragOver = useCallback(
		(eventData: DraxMonitorEventData) => {
			const {
				dragged,
				receiver,
				monitorOffsetRatio,
				draggedDimensions,
			} = eventData;
			//#region
			/*
			console.log(
				"dragged parent id: ",
				dragged.parentId,
				"index: ",
				dragged.payload.index
			);
			console.log(
				"receiver parent id: ",
				id,
				"index: ",
				receiver ? receiver.payload.index : "UNDEFINED"
			);
			*/
			//#endregion

			// if dragged item comes from other parent
			if (reorderable && dragged.parentId !== id) {
				const draggedInfo = {
					draggedPayload: dragged.payload,
					draggedParentId: dragged.parentId,
					...draggedDimensions,
				};
				updateShifts(draggedInfo, receiver?.payload);
			}

			// if dragged item comes from this list's parent
			if (reorderable && dragged.parentId === id) {
				// One of our list items is being dragged.
				const fromPayload: ListItemPayload = dragged.payload;

				// Find its current position index in the list, if any.
				const toPayload: ListItemPayload | undefined =
					receiver?.parentId === id ? receiver.payload : undefined;

				// Check and update currently dragged over position index.
				const toIndex = toPayload?.index;
				if (toIndex !== draggedToIndex.current) {
					onItemDragPositionChange?.({
						...eventData,
						toIndex,
						index: fromPayload.index,
						item: dataUpdated?.[fromPayload.originalIndex],
						previousIndex: draggedToIndex.current,
					});
					draggedToIndex.current = toIndex;
				}
				const draggedInfo = {
					draggedPayload: fromPayload,
					draggedParentId: dragged.parentId,
					...draggedDimensions,
				};
				// Update shift transforms for items in the list.
				updateShifts(draggedInfo, toPayload ?? fromPayload);
			}

			// Next, see if we need to auto-scroll.
			const ratio = horizontal ? monitorOffsetRatio.x : monitorOffsetRatio.y;
			if (
				(ratio > 0.1 && ratio < 0.9) ||
				(ratio > 0.06 &&
					ratio < 0.94 &&
					dummyItem &&
					receiver?.payload?.index === itemCount - 1)
			) {
				scrollStateRef.current = AutoScrollDirection.None;
				stopScroll();
			} else {
				if (
					ratio >= 0.94 ||
					(ratio >= 0.9 &&
						(!dummyItem ||
							(dummyItem && receiver?.payload?.index !== itemCount - 1)))
				) {
					scrollStateRef.current = AutoScrollDirection.Forward;
				} else if (
					ratio <= 0.06 ||
					(ratio <= 0.1 &&
						(!dummyItem ||
							(dummyItem && receiver?.payload?.index !== itemCount - 1)))
				) {
					scrollStateRef.current = AutoScrollDirection.Back;
				}
				startScroll();
			}
		},
		[
			id,
			reorderable,
			updateShifts,
			horizontal,
			stopScroll,
			startScroll,
			onItemDragPositionChange,
			dummyItem,
			dataUpdated,
			itemCount,
		]
	);

	// Monitor drag exits to stop scrolling, update shifts, and update draggedToIndex.
	const onMonitorDragExit = useCallback(
		(eventData: DraxMonitorEventData) => {
			// console.log('\n', 'onMonitorDragExit: id', id, '\n')
			return handleInternalDragEnd(eventData, false);
		},
		[handleInternalDragEnd]
	);

	/*
	 * Monitor drag ends to stop scrolling, update shifts, and possibly reorder.
	 * This addresses the Android case where if we drag a list item and auto-scroll
	 * too far, the drag gets cancelled.
	 */
	const onMonitorDragEnd = useCallback(
		(eventData: DraxMonitorEndEventData) => {
			// console.log('\n', 'onMonitorDragEnd id:', id, '\n')
			return handleInternalDragEnd(eventData, true);
		},
		[handleInternalDragEnd]
	);

	// Monitor drag drops to stop scrolling, update shifts, and possibly reorder.
	const onMonitorDragDrop = useCallback(
		(eventData: DraxMonitorDragDropEventData) => {
			// console.log('\n', 'onMonitorDragDrop id:', id, '\n')
			return handleInternalDragEnd(eventData, true);
		},
		[handleInternalDragEnd]
	);

	const onMonitorDragEnter = useCallback(
		(eventData: DraxMonitorEventData) => {
			// console.log('onMonitorDragEnter', id)
			if (eventData.dragged.parentId !== id) {
				// console.log('setShowDummy true')
				setShowDummy(true);
			}
		},
		[id]
	);

	return (
		<DraxView
			id={id}
			style={style}
			scrollPositionRef={scrollPositionRef}
			onMeasure={onMeasureContainer}
			onMonitorDragStart={onMonitorDragStart}
			onMonitorDragOver={onMonitorDragOver}
			onMonitorDragExit={onMonitorDragExit}
			onMonitorDragEnd={onMonitorDragEnd}
			onMonitorDragDrop={onMonitorDragDrop}
			onMonitorDragEnter={onMonitorDragEnter}
		>
			<DraxSubprovider parent={{ id, nodeHandleRef }}>
				<FlatList
					{...props}
					ref={setFlatListRefs}
					renderItem={renderItem}
					onScroll={onScroll}
					onContentSizeChange={onContentSizeChange}
					// @ts-ignore
					data={reorderedData}
				/>
			</DraxSubprovider>
		</DraxView>
	);
};

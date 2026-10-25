import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ViewMode,
  Booking,
  AmbulanceUnit,
  LatLng,
  TripStage,
  PatientProfile,
  BookingDocument,
  Hospital,
  SimulationState
} from './types/index.ts';
import {
  HOSPITALS,
  LANDMARKS,
  INITIAL_AMBULANCES,
  INITIAL_PATIENT,
} from './data/mockData.ts';
import {
  getDrivingRoute,
  reverseGeocode,
  findNearestAvailableAmbulance,
  calculateBearing,
  calculateHaversineDistance,
} from './services/routingService.ts';
import { Header } from './components/Common/Header.tsx';
import { UserDashboard } from './components/UserDashboard/UserDashboard.tsx';
import { OperatorDashboard } from './components/OperatorDashboard/OperatorDashboard.tsx';
import { HospitalDirectory } from './components/Hospitals/HospitalDirectory.tsx';
import { AmbulanceViewer3D } from './components/Three/AmbulanceViewer3D.tsx';
import { CloudinaryUploadModal } from './components/Cloudinary/CloudinaryUploadModal.tsx';
import { UserProfileView } from './components/Profile/UserProfileView.tsx';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

export default function App() {
  // 1. Primary Top Controls State
  const [currentView, setCurrentView] = useState<ViewMode>('user');

  // 2. Map & Route State (Default: Central Delhi NCR)
  const [pickup, setPickup] = useState<{ coords: LatLng; address: string }>({
    coords: { lat: 28.6327, lng: 77.2197 }, // Connaught Place, New Delhi
    address: 'Connaught Place (Inner Circle), Block A, New Delhi',
  });

  const [hospitals, setHospitals] = useState<Hospital[]>(() => {
    return HOSPITALS;
  });

  const [dropoff, setDropoff] = useState<{ coords: LatLng; address: string; hospitalId?: string }>({
    coords: { lat: HOSPITALS[0].lat, lng: HOSPITALS[0].lng }, // AIIMS, New Delhi
    address: `${HOSPITALS[0].name}, ${HOSPITALS[0].address}`,
    hospitalId: HOSPITALS[0].id,
  });

  const [routePolyline, setRoutePolyline] = useState<[number, number][]>([]);
  const [routeDistanceKm, setRouteDistanceKm] = useState<number>(7.8);
  const [routeEtaMins, setRouteEtaMins] = useState<number>(6);
  const [routeError, setRouteError] = useState<string | null>(null);

  // 3. Fleet & Bookings Simulation State
  const [ambulances, setAmbulances] = useState<AmbulanceUnit[]>(() => {
    const saved = localStorage.getItem('dropaid_ambulances');
    return saved ? JSON.parse(saved) : INITIAL_AMBULANCES;
  });

  const [bookings, setBookings] = useState<Booking[]>(() => {
    try {
      const saved = localStorage.getItem('dropaid_bookings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const nonDemo = parsed.filter((b) => b.id !== 'bk-demo-01');
          return nonDemo;
        }
      }
    } catch {
      // fallback
    }
    return [];
  });

  // Daily Ride Simulation State
  const [simulationState, setSimulationState] = useState<SimulationState>({
    status: 'idle',
    simulatedDay: 1,
    simulatedHour: 8,
    simulatedMinute: 0,
    speedMultiplier: 10,
    ridesTargetPerDay: 20,
    generatedCount: 0,
    activeCount: 0,
    completedCount: 0,
  });

  const [patientProfile, setPatientProfile] = useState<PatientProfile>(() => {
    try {
      const saved = localStorage.getItem('dropaid_patient_profile');
      if (saved) return JSON.parse(saved);
    } catch {
      // fallback
    }
    return INITIAL_PATIENT;
  });

  const [gpsAccuracy, setGpsAccuracy] = useState<number>(10);
  const [isDetectingGPS, setIsDetectingGPS] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const isSubmittingRef = useRef<boolean>(false);
  const routingRequestIdRef = useRef<number>(0);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Autonomous 5-Second Dispatch & Movement Engine Refs
  const [dispatchCountdown, setDispatchCountdown] = useState<number | null>(null);
  const dispatchCountdownRef = useRef<NodeJS.Timeout | null>(null);
  const movementIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const bookingsRef = useRef(bookings);
  bookingsRef.current = bookings;
  const ambulancesRef = useRef(ambulances);
  ambulancesRef.current = ambulances;

  // 4. Modals State
  const [is3DViewerOpen, setIs3DViewerOpen] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<
    'id_card' | 'insurance' | 'medical_history' | 'incident_photo' | 'hospital_photo' | 'driver_photo' | 'ambulance_photo'
  >('insurance');
  const [uploadEntityId, setUploadEntityId] = useState<string | undefined>(undefined);
  const [toastMessage, setToastMessage] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);

  // Active User Booking (excludes simulated rides from user-facing active card unless tracking)
  const activeBooking = bookings.find(
    (b) => !b.isSimulated && b.stage !== 'completed' && b.stage !== 'cancelled'
  ) || null;

  const assignedAmbulance = activeBooking?.assignedUnitId
    ? ambulances.find((a) => a.id === activeBooking.assignedUnitId) || null
    : null;

  // Persist State to LocalStorage
  useEffect(() => {
    localStorage.setItem('dropaid_bookings', JSON.stringify(bookings));
  }, [bookings]);

  useEffect(() => {
    localStorage.setItem('dropaid_ambulances', JSON.stringify(ambulances));
  }, [ambulances]);

  // Toast Helper
  const showToast = (text: string, type: 'success' | 'info' | 'error' = 'info') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3800);
  };

  // Sync with Server (simulation state, bookings, fleet, hospitals, and profile)
  useEffect(() => {
    const fetchSync = async () => {
      try {
        const res = await fetch('/api/sync');
        if (!res.ok) return;
        const data = await res.json();

        if (data.simulation) {
          setSimulationState(data.simulation);
        }
        if (Array.isArray(data.bookings)) {
          setBookings(data.bookings);
        }
        if (Array.isArray(data.ambulances) && data.ambulances.length > 0) {
          setAmbulances(data.ambulances);
        }
        if (Array.isArray(data.hospitals) && data.hospitals.length > 0) {
          setHospitals(data.hospitals);
        }
        if (data.profile) {
          setPatientProfile((prev) => ({ ...prev, ...data.profile }));
        }
      } catch {
        // silent sync
      }
    };

    fetchSync();
    const timer = setInterval(fetchSync, 2500);
    return () => clearInterval(timer);
  }, []);

  // Fetch initial profile from server on mount
  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await fetch('/api/profile');
        if (res.ok) {
          const data = await res.json();
          if (data.profile) {
            setPatientProfile(data.profile);
            localStorage.setItem('dropaid_patient_profile', JSON.stringify(data.profile));
          }
        }
      } catch (err) {
        console.warn('Profile fetch error, using local fallback:', err);
      }
    };
    fetchProfile();
  }, []);

  // Save profile changes (persisted in database & localStorage)
  const handleSaveProfile = async (updated: PatientProfile) => {
    setPatientProfile(updated);
    localStorage.setItem('dropaid_patient_profile', JSON.stringify(updated));

    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });

      if (!res.ok) {
        throw new Error('Server returned error');
      }

      showToast('Profile and medical records saved to database!', 'success');
    } catch (err) {
      console.warn('Error saving profile to server:', err);
      showToast('Profile saved in local storage (Server offline fallback).', 'info');
    }
  };

  // Recalculate Route preview when no active booking is running
  const calculateCurrentRoute = useCallback(async (start: LatLng, end: LatLng) => {
    setRouteError(null);
    const reqId = ++routingRequestIdRef.current;
    try {
      const result = await getDrivingRoute(start, end);
      if (reqId !== routingRequestIdRef.current) return;
      setRoutePolyline(result.polyline);
      setRouteDistanceKm(result.distanceKm);
      setRouteEtaMins(result.etaMinutes);
    } catch (err: any) {
      if (reqId === routingRequestIdRef.current) {
        console.warn('Failed to calculate route:', err);
        setRouteError('Route service calculating road grid path.');
      }
    }
  }, []);

  // Automatically update preview route if no active booking
  useEffect(() => {
    if (!activeBooking) {
      calculateCurrentRoute(pickup.coords, dropoff.coords);
    } else if (activeBooking.routePolyline && activeBooking.routePolyline.length > 0) {
      setRoutePolyline(activeBooking.routePolyline);
      setRouteDistanceKm(activeBooking.distanceKm);
      setRouteEtaMins(activeBooking.etaMinutes);
    }
  }, [pickup.coords, dropoff.coords, activeBooking?.id, activeBooking?.stage, calculateCurrentRoute]);

  // GPS Location Detection with Graceful Error & Permission Handling
  const handleDetectGPS = useCallback(() => {
    if (!navigator.geolocation) {
      const msg = 'Geolocation is not supported by your browser.';
      setGpsError(msg);
      showToast(msg, 'error');
      return;
    }

    setIsDetectingGPS(true);
    setGpsError(null);

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const accuracy = Math.round(pos.coords.accuracy || 12);
        setGpsAccuracy(accuracy);
        setGpsError(null);

        const address = await reverseGeocode(coords.lat, coords.lng);
        setPickup({ coords, address });
        setIsDetectingGPS(false);
        showToast(`GPS Position detected: ${address.split(',')[0]} (±${accuracy}m)`, 'success');
      },
      (err) => {
        setIsDetectingGPS(false);
        let errorMsg = 'GPS location unavailable.';
        if (err.code === err.PERMISSION_DENIED) {
          errorMsg = 'Location permission was denied by browser. Please enable location permissions or select your address below.';
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          errorMsg = 'GPS satellite fix or network position is currently unavailable.';
        } else if (err.code === err.TIMEOUT) {
          errorMsg = 'GPS location request timed out.';
        }
        setGpsError(errorMsg);
        showToast(errorMsg, 'error');
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 10000 }
    );
  }, []);

  // Map Change Handlers (Customer view before booking)
  const handlePickupChange = (coords: LatLng, address: string) => {
    setPickup({ coords, address });
  };

  const handleDropoffChange = (coords: LatLng, address: string, hospitalId?: string) => {
    setDropoff({ coords, address, hospitalId });
  };

  // EXECUTE AUTONOMOUS DISPATCH (Proximity road matching nearest available unit)
  const executeAutonomousDispatch = useCallback(async (bookingId: string, pickupCoords: LatLng) => {
    const currentAmbs = ambulancesRef.current;
    const nearestResult = findNearestAvailableAmbulance(pickupCoords, currentAmbs);

    if (!nearestResult) {
      setDispatchCountdown(null);
      showToast('No emergency units currently available in fleet. Tap Retry once a unit clears.', 'error');
      return;
    }

    const assigned = nearestResult.ambulance;
    let assignedPolyline: [number, number][] = [];
    let distKm = nearestResult.distanceKm;
    let etaMins = nearestResult.etaMinutes;

    try {
      const leg = await getDrivingRoute(assigned.location, pickupCoords);
      assignedPolyline = leg.polyline;
      distKm = leg.distanceKm;
      etaMins = leg.etaMinutes;
    } catch {
      assignedPolyline = [
        [assigned.location.lat, assigned.location.lng],
        [pickupCoords.lat, pickupCoords.lng],
      ];
    }

    const nowIso = new Date().toISOString();

    setAmbulances((prev) =>
      prev.map((a) =>
        a.id === assigned.id
          ? {
              ...a,
              status: 'en_route_pickup',
              currentBookingId: bookingId,
              speedKmH: 48,
              heading: calculateBearing(assigned.location, pickupCoords) || a.heading,
            }
          : a
      )
    );

    setBookings((prev) =>
      prev.map((b) =>
        b.id === bookingId
          ? {
              ...b,
              stage: 'en_route_pickup',
              assignedUnitId: assigned.id,
              routePolyline: assignedPolyline,
              distanceKm: distKm,
              etaMinutes: etaMins,
              currentWaypointIndex: 0,
              currentVehiclePosition: [assigned.location.lat, assigned.location.lng],
              stageTimestamps: {
                ...b.stageTimestamps,
                accepted: nowIso,
                dispatched: nowIso,
              },
              statusHistory: [
                ...(b.statusHistory || []),
                {
                  stage: 'en_route_pickup',
                  timestamp: nowIso,
                  note: `Auto-dispatched Unit ${assigned.callSign} (Driver: ${assigned.driverName}) within 5s proximity window`,
                },
              ],
            }
          : b
      )
    );

    setRoutePolyline(assignedPolyline);
    setRouteDistanceKm(distKm);
    setRouteEtaMins(etaMins);
    setDispatchCountdown(null);

    showToast(
      `Auto-Dispatched Unit ${assigned.callSign}! En route to pickup (ETA ~${etaMins}m).`,
      'success'
    );

    try {
      await fetch(`/api/bookings/${bookingId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: 'en_route_pickup',
          assignedUnitId: assigned.id,
          routePolyline: assignedPolyline,
          distanceKm: distKm,
          etaMinutes: etaMins,
          isOperator: false,
        }),
      });
    } catch {
      // quiet
    }
  }, []);

  // START 5-SECOND AUTONOMOUS COUNTDOWN
  const startAutonomousDispatch = useCallback((bookingId: string, pickupCoords: LatLng) => {
    if (dispatchCountdownRef.current) {
      clearInterval(dispatchCountdownRef.current);
      dispatchCountdownRef.current = null;
    }

    setDispatchCountdown(5);
    let secondsLeft = 5;

    dispatchCountdownRef.current = setInterval(async () => {
      secondsLeft -= 1;
      setDispatchCountdown(secondsLeft);

      if (secondsLeft <= 2) {
        if (dispatchCountdownRef.current) {
          clearInterval(dispatchCountdownRef.current);
          dispatchCountdownRef.current = null;
        }
        await executeAutonomousDispatch(bookingId, pickupCoords);
      }
    }, 1000);
  }, [executeAutonomousDispatch]);

  // RETRY DISPATCH HANDLER (User or Operator)
  const handleRetryDispatch = useCallback((bookingId: string) => {
    const bk = bookingsRef.current.find((b) => b.id === bookingId);
    if (!bk) return;

    const available = ambulancesRef.current.filter((a) => a.status === 'available');
    if (available.length === 0) {
      showToast('All 14 fleet units deployed on emergency calls. Please retry in a few moments.', 'error');
      return;
    }

    showToast('Retrying autonomous dispatch across Delhi NCR fleet...', 'info');
    startAutonomousDispatch(bookingId, bk.pickupCoords);
  }, [startAutonomousDispatch]);

  // CREATE EMERGENCY BOOKING (Hold 5s or Manual Form)
  // WITH 5-SECOND AUTONOMOUS PROXIMITY DISPATCH
  const handleCreateBooking = async (
    equipmentIds: string[],
    notes: string,
    bookingType: 'emergency_hold' | 'manual' = 'emergency_hold'
  ) => {
    if (isSubmittingRef.current) return;
    if (activeBooking && activeBooking.stage !== 'completed' && activeBooking.stage !== 'cancelled') {
      showToast('An emergency booking is already in progress.', 'info');
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);

    const newBookingId = `bk-${Date.now()}`;
    const trackingCode = `DA-${Math.floor(1000 + Math.random() * 9000)}`;
    const nowIso = new Date().toISOString();

    const availableAmbulances = ambulances.filter((a) => a.status === 'available');
    const hasAvailable = availableAmbulances.length > 0;

    const newBooking: Booking = {
      id: newBookingId,
      trackingCode,
      createdAt: nowIso,
      patientName: patientProfile.name,
      patientPhone: patientProfile.phone,
      patientNotes: `${bookingType === 'emergency_hold' ? '[5s Hold Emergency] ' : '[Manual Assisted] '}${notes}`,
      pickupAddress: pickup.address,
      pickupCoords: { ...pickup.coords },
      dropoffAddress: dropoff.address,
      dropoffCoords: { ...dropoff.coords },
      destinationHospitalId: dropoff.hospitalId,
      equipmentRequested: equipmentIds,
      stage: 'pending',
      assignedUnitId: undefined,
      etaMinutes: 5,
      distanceKm: 4.8,
      routePolyline: [],
      currentVehiclePosition: undefined,
      currentWaypointIndex: 0,
      priceEst: Math.round(150 + 4.8 * 18),
      documents: [],
      stageTimestamps: {
        requested: nowIso,
      },
      isSimulated: false,
      statusHistory: [
        { stage: 'pending', timestamp: nowIso, note: 'Emergency dispatch request registered' },
      ],
    };

    setRoutePolyline([]);
    setBookings((prev) => [newBooking, ...prev.filter((b) => b.id !== newBookingId)]);

    if (!hasAvailable) {
      setDispatchCountdown(null);
      showToast('No emergency units currently available in fleet. Tap Retry once a unit clears.', 'error');
    } else {
      showToast('Emergency call logged! Auto-matching nearest unit within 5 seconds...', 'info');
      startAutonomousDispatch(newBookingId, pickup.coords);
    }

    // Sync to Backend API
    try {
      await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientName: patientProfile.name,
          patientPhone: patientProfile.phone,
          patientNotes: notes,
          pickupAddress: pickup.address,
          pickupCoords: pickup.coords,
          dropoffAddress: dropoff.address,
          dropoffCoords: dropoff.coords,
          destinationHospitalId: dropoff.hospitalId,
          equipmentRequested: equipmentIds,
          bookingType,
        }),
      });
    } catch (apiErr) {
      console.warn('Backend API booking network glitch, preserved in state:', apiErr);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  // RETRY / RECALCULATE ACTIVE TRIP ROUTE
  const handleRetryRoute = async () => {
    if (!activeBooking) {
      calculateCurrentRoute(pickup.coords, dropoff.coords);
      return;
    }

    setRouteError(null);
    const reqId = ++routingRequestIdRef.current;

    if (activeBooking.stage === 'transporting') {
      const assigned = ambulances.find((a) => a.id === activeBooking.assignedUnitId);
      const origin = assigned?.location || activeBooking.pickupCoords;
      const dest = activeBooking.dropoffCoords;
      setRoutePolyline([]);

      try {
        const hospRoute = await getDrivingRoute(origin, dest);
        if (reqId !== routingRequestIdRef.current) return;
        setRoutePolyline(hospRoute.polyline);
        setRouteDistanceKm(hospRoute.distanceKm);
        setRouteEtaMins(hospRoute.etaMinutes);
        setRouteError(null);

        setBookings((prev) =>
          prev.map((b) =>
            b.id === activeBooking.id
              ? {
                  ...b,
                  routePolyline: hospRoute.polyline,
                  distanceKm: hospRoute.distanceKm,
                  etaMinutes: hospRoute.etaMinutes,
                }
              : b
          )
        );
        showToast('Hospital road route recalculated successfully.', 'success');
      } catch {
        if (reqId === routingRequestIdRef.current) {
          setRoutePolyline([]);
          setRouteError('Failed to fetch hospital road route. Click to retry.');
        }
      }
    } else if (activeBooking.stage === 'en_route_pickup') {
      const assigned = ambulances.find((a) => a.id === activeBooking.assignedUnitId);
      if (assigned) {
        setRoutePolyline([]);
        try {
          const leg1 = await getDrivingRoute(assigned.location, activeBooking.pickupCoords);
          if (reqId !== routingRequestIdRef.current) return;
          setRoutePolyline(leg1.polyline);
          setRouteDistanceKm(leg1.distanceKm);
          setRouteEtaMins(leg1.etaMinutes);
          setRouteError(null);
          showToast('Pickup route recalculated successfully.', 'success');
        } catch {
          if (reqId === routingRequestIdRef.current) {
            setRoutePolyline([]);
            setRouteError('Failed to fetch route to patient. Click to retry.');
          }
        }
      }
    } else {
      calculateCurrentRoute(pickup.coords, dropoff.coords);
    }
  };

  // ADVANCE TRIP STAGE (Multi-Phase Road Routing & Availability Transition)
  const handleAdvanceStage = async (bookingId: string, nextStage: TripStage) => {
    const currentBk = bookings.find((b) => b.id === bookingId);
    const assignedId = currentBk?.assignedUnitId;
    const assignedUnit = ambulances.find((a) => a.id === assignedId);

    setRoutePolyline([]);
    setRouteError(null);

    setBookings((prev) =>
      prev.map((b) => {
        if (b.id !== bookingId) return b;
        return {
          ...b,
          stage: nextStage,
          routePolyline: [],
          stageTimestamps: {
            ...b.stageTimestamps,
            ...(nextStage === 'accepted' ? { accepted: new Date().toISOString() } : {}),
            ...(nextStage === 'en_route_pickup' ? { dispatched: new Date().toISOString() } : {}),
            ...(nextStage === 'on_scene' ? { arrivedScene: new Date().toISOString() } : {}),
            ...(nextStage === 'transporting' ? { departedScene: new Date().toISOString() } : {}),
            ...(nextStage === 'at_hospital' ? { arrivedHospital: new Date().toISOString() } : {}),
            ...(nextStage === 'completed' ? { completed: new Date().toISOString() } : {}),
          },
        };
      })
    );

    // PHASE 2 TRANSITION: "Patient Picked Up" -> Hospital ER Route
    if (nextStage === 'transporting' && currentBk) {
      if (assignedId) {
        setAmbulances((prev) =>
          prev.map((a) => (a.id === assignedId ? { ...a, status: 'transporting', speedKmH: 48 } : a))
        );
      }

      const originLocation = assignedUnit?.location || currentBk.pickupCoords;
      const hospitalLocation = currentBk.dropoffCoords;
      const reqId = ++routingRequestIdRef.current;

      try {
        const hospRoute = await getDrivingRoute(originLocation, hospitalLocation);
        if (reqId !== routingRequestIdRef.current) return;

        setRoutePolyline(hospRoute.polyline);
        setRouteDistanceKm(hospRoute.distanceKm);
        setRouteEtaMins(hospRoute.etaMinutes);
        setRouteError(null);

        setBookings((prev) =>
          prev.map((b) =>
            b.id === bookingId
              ? {
                  ...b,
                  routePolyline: hospRoute.polyline,
                  distanceKm: hospRoute.distanceKm,
                  etaMinutes: hospRoute.etaMinutes,
                  currentVehiclePosition: [originLocation.lat, originLocation.lng],
                  currentWaypointIndex: 0,
                }
              : b
          )
        );

        try {
          await fetch(`/api/bookings/${bookingId}/stage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stage: 'transporting',
              assignedUnitId: assignedId,
              routePolyline: hospRoute.polyline,
              distanceKm: hospRoute.distanceKm,
              etaMinutes: hospRoute.etaMinutes,
              isOperator: true,
            }),
          });
        } catch {
          // quiet
        }

        showToast(
          `Patient Picked Up! En route to ${currentBk.dropoffAddress.split(',')[0]} (ETA ${hospRoute.etaMinutes}m)`,
          'info'
        );
      } catch (routingErr) {
        if (reqId === routingRequestIdRef.current) {
          console.error('Failed to calculate hospital route:', routingErr);
          setRoutePolyline([]);
          setRouteError('Failed to fetch hospital road route. Click to retry.');
        }
      }
    } else if (nextStage === 'on_scene' && assignedId && currentBk) {
      setAmbulances((prev) =>
        prev.map((a) =>
          a.id === assignedId
            ? { ...a, status: 'on_scene', location: { ...currentBk.pickupCoords }, speedKmH: 0 }
            : a
        )
      );
      try {
        await fetch(`/api/bookings/${bookingId}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'on_scene', isOperator: true }),
        });
      } catch {
        // quiet
      }
      showToast(`Ambulance arrived at patient location. Initiating triage.`, 'info');
    } else if (nextStage === 'at_hospital' && assignedId && currentBk) {
      setAmbulances((prev) =>
        prev.map((a) =>
          a.id === assignedId
            ? { ...a, status: 'at_hospital', location: { ...currentBk.dropoffCoords }, speedKmH: 0 }
            : a
        )
      );
      try {
        await fetch(`/api/bookings/${bookingId}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'at_hospital', isOperator: true }),
        });
      } catch {
        // quiet
      }
      showToast(`Arrived at ${currentBk.dropoffAddress.split(',')[0]} ER trauma bay.`, 'info');
    } else if (nextStage === 'completed') {
      if (assignedId && assignedUnit) {
        setAmbulances((prev) =>
          prev.map((a) =>
            a.id === assignedId
              ? {
                  ...a,
                  location: { ...assignedUnit.baseLocation },
                  status: 'available',
                  currentBookingId: undefined,
                  speedKmH: 0,
                }
              : a
          )
        );
      }
      try {
        await fetch(`/api/bookings/${bookingId}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'completed', isOperator: true }),
        });
      } catch {
        // quiet
      }
      showToast('Emergency transfer completed. Unit returned to service.', 'success');
    } else if (nextStage === 'cancelled') {
      if (assignedId && assignedUnit) {
        setAmbulances((prev) =>
          prev.map((a) =>
            a.id === assignedId
              ? {
                  ...a,
                  location: { ...assignedUnit.baseLocation },
                  status: 'available',
                  currentBookingId: undefined,
                  speedKmH: 0,
                }
              : a
          )
        );
      }
      try {
        await fetch(`/api/bookings/${bookingId}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stage: 'cancelled', isOperator: true }),
        });
      } catch {
        // quiet
      }
      showToast('Booking cancelled.', 'info');
    }
  };

  // CONTINUOUS ROAD-FOLLOWING VEHICLE MOVEMENT ENGINE
  useEffect(() => {
    const hasMovingTrip = bookings.some(
      (b) => (b.stage === 'en_route_pickup' || b.stage === 'transporting') && b.assignedUnitId
    );

    if (!hasMovingTrip) {
      if (movementIntervalRef.current) {
        clearInterval(movementIntervalRef.current);
        movementIntervalRef.current = null;
      }
      return;
    }

    if (movementIntervalRef.current) return;

    movementIntervalRef.current = setInterval(() => {
      const currentBookings = bookingsRef.current;

      currentBookings.forEach((b) => {
        if ((b.stage !== 'en_route_pickup' && b.stage !== 'transporting') || !b.assignedUnitId) {
          return;
        }

        const poly = b.routePolyline;
        if (!poly || poly.length < 2) return;

        const currentIndex = b.currentWaypointIndex ?? 0;
        const step = poly.length > 80 ? 2 : 1;
        const nextIndex = Math.min(currentIndex + step, poly.length - 1);

        const currentCoord = poly[nextIndex];
        const prevCoord = poly[Math.max(0, nextIndex - 1)];

        const heading = calculateBearing(
          { lat: prevCoord[0], lng: prevCoord[1] },
          { lat: currentCoord[0], lng: currentCoord[1] }
        );

        let remDistKm = 0;
        for (let i = nextIndex; i < poly.length - 1; i++) {
          remDistKm += calculateHaversineDistance(
            { lat: poly[i][0], lng: poly[i][1] },
            { lat: poly[i + 1][0], lng: poly[i + 1][1] }
          );
        }
        remDistKm = Math.round(remDistKm * 10) / 10;
        const speedKmH = 48;
        const remEtaMins = Math.max(1, Math.round((remDistKm / speedKmH) * 60));

        const isArrived = nextIndex >= poly.length - 1;

        if (!isArrived) {
          setAmbulances((prev) =>
            prev.map((a) =>
              a.id === b.assignedUnitId
                ? {
                    ...a,
                    location: { lat: currentCoord[0], lng: currentCoord[1] },
                    heading: heading || a.heading,
                    speedKmH: 48,
                  }
                : a
            )
          );

          setBookings((prev) =>
            prev.map((bk) =>
              bk.id === b.id
                ? {
                    ...bk,
                    currentWaypointIndex: nextIndex,
                    currentVehiclePosition: [currentCoord[0], currentCoord[1]],
                    distanceKm: remDistKm,
                    etaMinutes: remEtaMins,
                  }
                : bk
            )
          );

          if (activeBooking && activeBooking.id === b.id) {
            setRouteDistanceKm(remDistKm);
            setRouteEtaMins(remEtaMins);
          }
        } else {
          // Arrived at destination waypoint
          if (b.stage === 'en_route_pickup') {
            const pickupFinal = b.pickupCoords;
            setAmbulances((prev) =>
              prev.map((a) =>
                a.id === b.assignedUnitId
                  ? { ...a, location: { ...pickupFinal }, speedKmH: 0 }
                  : a
              )
            );

            handleAdvanceStage(b.id, 'on_scene');

            setTimeout(() => {
              handleAdvanceStage(b.id, 'transporting');
            }, 4500);
          } else if (b.stage === 'transporting') {
            const hospFinal = b.dropoffCoords;
            setAmbulances((prev) =>
              prev.map((a) =>
                a.id === b.assignedUnitId
                  ? { ...a, location: { ...hospFinal }, speedKmH: 0 }
                  : a
              )
            );

            handleAdvanceStage(b.id, 'at_hospital');

            setTimeout(() => {
              handleAdvanceStage(b.id, 'completed');
            }, 5000);
          }
        }
      });
    }, 850);

    return () => {
      if (movementIntervalRef.current) {
        clearInterval(movementIntervalRef.current);
        movementIntervalRef.current = null;
      }
    };
  }, [bookings, activeBooking?.id]);

  // UNMOUNT CLEANUP
  useEffect(() => {
    return () => {
      if (dispatchCountdownRef.current) clearInterval(dispatchCountdownRef.current);
      if (movementIntervalRef.current) clearInterval(movementIntervalRef.current);
    };
  }, []);

  // ACCEPT BOOKING (Operator force accept)
  const handleAcceptBooking = async (bookingId: string) => {
    if (dispatchCountdownRef.current) {
      clearInterval(dispatchCountdownRef.current);
      dispatchCountdownRef.current = null;
    }
    setDispatchCountdown(null);

    const currentBk = bookings.find((b) => b.id === bookingId);
    if (!currentBk) return;

    const nearestResult = findNearestAvailableAmbulance(currentBk.pickupCoords, ambulances);
    const assigned = nearestResult?.ambulance || ambulances.find((a) => a.status === 'available') || ambulances[0];

    setRoutePolyline([]);
    setRouteError(null);
    const reqId = ++routingRequestIdRef.current;

    let phase1Polyline: [number, number][] = [];
    let dispatchDistKm = nearestResult?.distanceKm || 4.2;
    let dispatchEtaMins = nearestResult?.etaMinutes || 5;

    try {
      const leg1 = await getDrivingRoute(assigned.location, currentBk.pickupCoords);
      if (reqId !== routingRequestIdRef.current) return;
      phase1Polyline = leg1.polyline;
      dispatchDistKm = leg1.distanceKm;
      dispatchEtaMins = leg1.etaMinutes;
    } catch {
      phase1Polyline = [
        [assigned.location.lat, assigned.location.lng],
        [currentBk.pickupCoords.lat, currentBk.pickupCoords.lng],
      ];
    }

    setRoutePolyline(phase1Polyline);
    setRouteDistanceKm(dispatchDistKm);
    setRouteEtaMins(dispatchEtaMins);

    setAmbulances((prev) =>
      prev.map((a) =>
        a.id === assigned.id
          ? { ...a, status: 'en_route_pickup', currentBookingId: bookingId, speedKmH: 48 }
          : a
      )
    );

    setBookings((prev) =>
      prev.map((b) =>
        b.id === bookingId
          ? {
              ...b,
              stage: 'en_route_pickup',
              assignedUnitId: assigned.id,
              routePolyline: phase1Polyline,
              distanceKm: dispatchDistKm,
              etaMinutes: dispatchEtaMins,
              currentWaypointIndex: 0,
              currentVehiclePosition: [assigned.location.lat, assigned.location.lng],
            }
          : b
      )
    );

    try {
      await fetch(`/api/bookings/${bookingId}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: 'en_route_pickup',
          assignedUnitId: assigned.id,
          routePolyline: phase1Polyline,
          distanceKm: dispatchDistKm,
          etaMinutes: dispatchEtaMins,
          isOperator: true,
        }),
      });
    } catch {
      // quiet
    }

    showToast(
      `Dispatched ${assigned.callSign} from ${assigned.stationName} (ETA ~${dispatchEtaMins}m)`,
      'success'
    );
  };

  const handleRejectBooking = (bookingId: string) => {
    handleAdvanceStage(bookingId, 'cancelled');
  };

  // OPERATOR OVERRIDE UNIT ASSIGNMENT
  const handleAssignUnit = async (bookingId: string, unitId: string) => {
    const unit = ambulances.find((a) => a.id === unitId);
    const bk = bookings.find((b) => b.id === bookingId);
    if (!unit || !bk) return;

    setRoutePolyline([]);
    const reqId = ++routingRequestIdRef.current;

    let newPolyline: [number, number][] = [];
    let newDist = bk.distanceKm;
    let newEta = bk.etaMinutes;

    try {
      const newRoute = await getDrivingRoute(unit.location, bk.pickupCoords);
      if (reqId === routingRequestIdRef.current) {
        newPolyline = newRoute.polyline;
        newDist = newRoute.distanceKm;
        newEta = newRoute.etaMinutes;
        setRoutePolyline(newPolyline);
        setRouteDistanceKm(newDist);
        setRouteEtaMins(newEta);
      }
    } catch {
      newPolyline = [[unit.location.lat, unit.location.lng], [bk.pickupCoords.lat, bk.pickupCoords.lng]];
    }

    setBookings((prev) =>
      prev.map((b) =>
        b.id === bookingId
          ? {
              ...b,
              assignedUnitId: unitId,
              stage: b.stage === 'pending' ? 'en_route_pickup' : b.stage,
              routePolyline: newPolyline,
              distanceKm: newDist,
              etaMinutes: newEta,
            }
          : b
      )
    );

    setAmbulances((prev) =>
      prev.map((a) =>
        a.id === unitId
          ? { ...a, status: (bk.stage === 'transporting' ? 'transporting' : 'en_route_pickup') as any, currentBookingId: bookingId }
          : a.currentBookingId === bookingId
          ? { ...a, status: 'available', currentBookingId: undefined }
          : a
      )
    );

    try {
      await fetch(`/api/bookings/${bookingId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId }),
      });
    } catch {
      // quiet
    }

    showToast(`Operator override confirmed: assigned to ${unit.callSign}`, 'success');
  };

  // CANCEL BOOKING (Enforces restriction after patient pickup)
  const handleCancelActiveBooking = (bookingId: string) => {
    const bk = bookings.find((b) => b.id === bookingId);
    if (!bk) return;

    if (
      bk.stage === 'transporting' ||
      bk.stage === 'at_hospital' ||
      bk.stage === 'completed'
    ) {
      showToast('Your trip is in progress. Contact the assigned operator if assistance is required.', 'error');
      return;
    }

    if (dispatchCountdownRef.current) {
      clearInterval(dispatchCountdownRef.current);
      dispatchCountdownRef.current = null;
    }
    setDispatchCountdown(null);

    handleAdvanceStage(bookingId, 'cancelled');
  };

  // OPERATOR REROUTE DESTINATION
  const handleOperatorReroute = async (bookingId: string, hospital: Hospital) => {
    const targetBooking = bookings.find((b) => b.id === bookingId);
    if (!targetBooking) return;

    const newDropoffCoords: LatLng = { lat: hospital.lat, lng: hospital.lng };
    const newDropoffAddress = `${hospital.name}, ${hospital.address}`;

    setDropoff({
      coords: newDropoffCoords,
      address: newDropoffAddress,
      hospitalId: hospital.id,
    });

    let newPolyline = routePolyline;
    let newDist = routeDistanceKm;
    let newEta = routeEtaMins;

    const assigned = ambulances.find((a) => a.id === targetBooking.assignedUnitId);
    if (targetBooking.stage === 'transporting' && assigned) {
      try {
        const reqId = ++routingRequestIdRef.current;
        const newRoute = await getDrivingRoute(assigned.location, newDropoffCoords);
        if (reqId === routingRequestIdRef.current) {
          newPolyline = newRoute.polyline;
          newDist = newRoute.distanceKm;
          newEta = newRoute.etaMinutes;
          setRoutePolyline(newPolyline);
          setRouteDistanceKm(newDist);
          setRouteEtaMins(newEta);
        }
      } catch (err) {
        console.warn('Operator reroute road routing failed:', err);
      }
    }

    setBookings((prev) =>
      prev.map((b) =>
        b.id === bookingId
          ? {
              ...b,
              dropoffCoords: newDropoffCoords,
              dropoffAddress: newDropoffAddress,
              destinationHospitalId: hospital.id,
              routePolyline: targetBooking.stage === 'transporting' ? newPolyline : b.routePolyline,
              distanceKm: targetBooking.stage === 'transporting' ? newDist : b.distanceKm,
              etaMinutes: targetBooking.stage === 'transporting' ? newEta : b.etaMinutes,
            }
          : b
      )
    );

    try {
      await fetch(`/api/bookings/${bookingId}/reroute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hospitalId: hospital.id,
          dropoffCoords: newDropoffCoords,
          dropoffAddress: newDropoffAddress,
          polyline: newPolyline,
          distanceKm: newDist,
          etaMinutes: newEta,
        }),
      });
    } catch (err) {
      console.warn('Failed to sync reroute to backend:', err);
    }

    showToast(`Destination rerouted to ${hospital.name} (${hospital.traumaLevel}) by Authorized Operator`, 'success');
  };

  // RESET STATE
  const handleResetSimulation = async () => {
    if (dispatchCountdownRef.current) {
      clearInterval(dispatchCountdownRef.current);
      dispatchCountdownRef.current = null;
    }
    if (movementIntervalRef.current) {
      clearInterval(movementIntervalRef.current);
      movementIntervalRef.current = null;
    }
    setDispatchCountdown(null);

    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch {
      // quiet
    }

    localStorage.removeItem('dropaid_bookings');
    localStorage.removeItem('dropaid_ambulances');

    setAmbulances(INITIAL_AMBULANCES);
    const defaultPickup = {
      coords: { lat: 28.6327, lng: 77.2197 },
      address: 'Connaught Place (Inner Circle), Block A, New Delhi',
    };
    const defaultDropoff = {
      coords: { lat: HOSPITALS[0].lat, lng: HOSPITALS[0].lng },
      address: `${HOSPITALS[0].name}, ${HOSPITALS[0].address}`,
      hospitalId: HOSPITALS[0].id,
    };
    setPickup(defaultPickup);
    setDropoff(defaultDropoff);
    setGpsError(null);
    setBookings([]);
    calculateCurrentRoute(defaultPickup.coords, defaultDropoff.coords);

    showToast('Platform reset. All 14 ambulances returned to base hospital emergency bays.', 'info');
  };

  // SIMULATION CONTROLS
  const handleStartSimulation = async () => {
    try {
      const res = await fetch('/api/simulation/start', { method: 'POST' });
      const data = await res.json();
      if (data.state) setSimulationState(data.state);
      showToast('Daily Ride Simulation started (~20 rides/day schedule)', 'success');
    } catch {
      showToast('Failed to start simulation', 'error');
    }
  };

  const handlePauseSimulation = async () => {
    try {
      const res = await fetch('/api/simulation/pause', { method: 'POST' });
      const data = await res.json();
      if (data.state) setSimulationState(data.state);
      showToast('Daily Ride Simulation paused', 'info');
    } catch {
      showToast('Failed to pause simulation', 'error');
    }
  };

  const handleChangeSimulationSpeed = async (multiplier: number) => {
    try {
      const res = await fetch('/api/simulation/speed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier }),
      });
      const data = await res.json();
      if (data.speedMultiplier) {
        setSimulationState((prev) => ({ ...prev, speedMultiplier: data.speedMultiplier }));
      }
    } catch {
      // quiet
    }
  };

  // CLOUDINARY MODAL TRIGGERS FOR HOSPITALS & DRIVERS
  const handleOpenHospitalPhotoUpload = (hospitalId: string) => {
    setUploadCategory('hospital_photo');
    setUploadEntityId(hospitalId);
    setIsUploadModalOpen(true);
  };

  const handleOpenDriverPhotoUpload = (unitId: string) => {
    setUploadCategory('driver_photo');
    setUploadEntityId(unitId);
    setIsUploadModalOpen(true);
  };

  const handleAssetUploaded = async (asset: { url: string; publicId: string; source: string; name: string }) => {
    if (uploadCategory === 'hospital_photo' && uploadEntityId) {
      setHospitals((prev) =>
        prev.map((h) => (h.id === uploadEntityId ? { ...h, image: asset.url, cloudinaryPublicId: asset.publicId } : h))
      );
      try {
        await fetch(`/api/hospitals/${uploadEntityId}/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageUrl: asset.url, publicId: asset.publicId }),
        });
      } catch {
        // quiet
      }
      showToast('Hospital image updated and delivered via Cloudinary!', 'success');
    } else if (uploadCategory === 'driver_photo' && uploadEntityId) {
      setAmbulances((prev) =>
        prev.map((a) => (a.id === uploadEntityId ? { ...a, driverPhoto: asset.url, driverPhotoPublicId: asset.publicId } : a))
      );
      try {
        await fetch(`/api/fleet/${uploadEntityId}/photo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoUrl: asset.url, publicId: asset.publicId, target: 'driver' }),
        });
      } catch {
        // quiet
      }
      showToast('Driver photo updated and delivered via Cloudinary!', 'success');
    }
  };

  const handleUploadComplete = (doc: BookingDocument) => {
    setPatientProfile((prev) => ({
      ...prev,
      documents: [doc, ...(prev as any).documents || []],
    }));
    showToast(`Document "${doc.name}" securely attached.`, 'success');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-sky-500 selection:text-white">
      {/* Top Header Navigation */}
      <Header
        currentView={currentView}
        onViewChange={(v) => setCurrentView(v)}
        onReset={handleResetSimulation}
        onOpen3DViewer={() => setIs3DViewerOpen(true)}
        activeBookingCount={bookings.filter((b) => b.stage !== 'completed' && b.stage !== 'cancelled').length}
      />

      {/* Toast Notification Banner */}
      {toastMessage && (
        <div className="fixed top-20 right-6 z-50 flex items-center gap-2 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl border border-slate-700 animate-in fade-in slide-in-from-top-2">
          {toastMessage.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-sky-400 shrink-0" />
          )}
          <span>{toastMessage.text}</span>
          <button
            onClick={() => setToastMessage(null)}
            className="text-slate-400 hover:text-white ml-2 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {currentView === 'profile' ? (
          /* Dedicated My Profile Page */
          <UserProfileView
            profile={patientProfile}
            onSaveProfile={handleSaveProfile}
            onBackToHome={() => setCurrentView('user')}
          />
        ) : currentView === 'hospitals' ? (
          /* Dedicated Hospital Directory Accessible Exclusively via Top Navbar */
          <HospitalDirectory
            hospitals={hospitals}
            currentDestinationId={dropoff.hospitalId}
            onSelectHospital={(hosp) => {
              handleDropoffChange({ lat: hosp.lat, lng: hosp.lng }, `${hosp.name}, ${hosp.address}`, hosp.id);
              setCurrentView('user');
              showToast(`${hosp.name} set as emergency destination.`, 'success');
            }}
            onUploadHospitalImage={handleOpenHospitalPhotoUpload}
          />
        ) : currentView === 'user' ? (
          /* User / Patient Emergency Booking & Live Tracking Dashboard */
          <UserDashboard
            currentPickup={pickup}
            currentDropoff={dropoff}
            onPickupChange={handlePickupChange}
            onDropoffChange={handleDropoffChange}
            onDetectGPS={handleDetectGPS}
            isDetectingGPS={isDetectingGPS}
            gpsAccuracy={gpsAccuracy}
            gpsError={gpsError}
            activeBooking={activeBooking}
            assignedAmbulance={assignedAmbulance}
            bookingHistory={bookings.filter((b) => !b.isSimulated)}
            onSubmitBooking={handleCreateBooking}
            onCancelActiveBooking={handleCancelActiveBooking}
            patientProfile={patientProfile}
            onOpenUploadModal={(cat) => {
              setUploadCategory(cat);
              setUploadEntityId(undefined);
              setIsUploadModalOpen(true);
            }}
            onOpen3DModal={() => setIs3DViewerOpen(true)}
            ambulances={ambulances}
            routePolyline={routePolyline}
            routeError={routeError}
            onRecalculateRoute={handleRetryRoute}
            isSubmitting={isSubmitting}
            onRetryDispatch={handleRetryDispatch}
            dispatchCountdown={dispatchCountdown}
            onNavigateToProfile={() => setCurrentView('profile')}
          />
        ) : (
          /* Dedicated Operator Dashboard (Fleet Map, Active Trips with Override, Driver Availability, Trip History & Simulation) */
          <OperatorDashboard
            bookings={bookings}
            ambulances={ambulances}
            onAcceptBooking={handleAcceptBooking}
            onRejectBooking={handleRejectBooking}
            onAssignUnit={handleAssignUnit}
            onAdvanceStage={handleAdvanceStage}
            onOperatorReroute={handleOperatorReroute}
            onUploadDriverPhoto={handleOpenDriverPhotoUpload}
            simulationState={simulationState}
            onStartSimulation={handleStartSimulation}
            onPauseSimulation={handlePauseSimulation}
            onResetSimulation={handleResetSimulation}
            onChangeSimulationSpeed={handleChangeSimulationSpeed}
            onOpenDriverView={() => {}}
            onOpen3DViewer={() => setIs3DViewerOpen(true)}
          />
        )}
      </main>

      {/* 3D Ambulance Telemetry Modal */}
      {is3DViewerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-xs">
          <div className="w-full max-w-5xl overflow-hidden rounded-xl bg-slate-900 border border-slate-700 shadow-2xl animate-in fade-in zoom-in-95">
            <AmbulanceViewer3D onClose={() => setIs3DViewerOpen(false)} />
          </div>
        </div>
      )}

      {/* Cloudinary Document / Asset Upload Modal */}
      <CloudinaryUploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUploadComplete={handleUploadComplete}
        onAssetUploaded={handleAssetUploaded}
        targetCategory={uploadCategory}
        entityId={uploadEntityId}
        title={
          uploadCategory === 'hospital_photo'
            ? 'Upload Hospital Image to Cloudinary'
            : uploadCategory === 'driver_photo'
            ? 'Upload Paramedic Driver Photo to Cloudinary'
            : 'Upload Medical Document / Scene Photo'
        }
      />

      {/* Accessible Footer */}
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-slate-900">Drop<span className="text-sky-600">Aid</span></span>
            <span>· Delhi NCR Emergency Medical Dispatch & Telemetry System</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-slate-400">
            <span>Verified Base Bays (10 Hospitals)</span>
            <span>·</span>
            <span>Active Fleet: 14 Units</span>
            <span>·</span>
            <span>Cloudinary CDN Storage Ready</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

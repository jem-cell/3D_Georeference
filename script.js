let scene, camera, renderer, controls;
let points = [];
let mapTiles = []; // Store map tiles to toggle visibility
const fileInput = document.getElementById('fileInput');
const statusDiv = document.getElementById('status');
const sceneContainer = document.getElementById('scene-container');

// Initialize Three.js Scene
function init3DScene() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a); // Match bg-color
    scene.fog = new THREE.FogExp2(0x0f172a, 0.002);

    // Camera
    camera = new THREE.PerspectiveCamera(60, sceneContainer.clientWidth / sceneContainer.clientHeight, 0.1, 10000);
    camera.position.set(0, 50, 100);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    sceneContainer.appendChild(renderer.domElement);

    // Controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.minDistance = 1;
    controls.maxDistance = 5000;
    controls.maxPolarAngle = Math.PI / 2; // Don't go below ground

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // Grid Helper (Ground)
    const gridHelper = new THREE.GridHelper(1000, 50, 0x38bdf8, 0x1e293b);
    scene.add(gridHelper);

    // Axes Helper
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);

    // Handle Resize
    window.addEventListener('resize', onWindowResize, false);

    // Interaction
    window.addEventListener('mousemove', onMouseMove, false);

    animate();
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById('tooltip');
let hoveredPoint = null;

function onMouseMove(event) {
    // Calculate mouse position in normalized device coordinates
    // (-1 to +1) for both components
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update tooltip position
    tooltip.style.left = (event.clientX + 15) + 'px';
    tooltip.style.top = (event.clientY + 15) + 'px';
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = sceneContainer.clientWidth / sceneContainer.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(sceneContainer.clientWidth, sceneContainer.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update();

    // Raycasting
    if (camera && scene) {
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(points);

        if (intersects.length > 0) {
            const object = intersects[0].object;

            if (hoveredPoint !== object) {
                // Reset previous
                if (hoveredPoint) hoveredPoint.material.color.setHex(0x38bdf8);

                // Highlight new
                hoveredPoint = object;
                hoveredPoint.material.color.setHex(0x22c55e); // Green on hover

                // Show tooltip
                tooltip.style.display = 'block';
                // Get basename (handle both / and \ just in case, though zip usually uses /)
                const basename = object.userData.name.split(/[/\\]/).pop();
                const name = basename.split('.')[0]; // Remove extension
                const height = object.userData.alt.toFixed(1);
                tooltip.innerHTML = `<strong>${name}</strong><br>Height: ${height}m`;
            }
        } else {
            if (hoveredPoint) {
                hoveredPoint.material.color.setHex(0x38bdf8);
                hoveredPoint = null;
                tooltip.style.display = 'none';
            }
        }
    }

    if (renderer && scene && camera) renderer.render(scene, camera);
}

init3DScene();

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    statusDiv.textContent = 'Processing ZIP file...';
    statusDiv.style.color = 'var(--accent-color)';

    try {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);

        // Clear existing points
        points.forEach(p => scene.remove(p));
        points = [];

        const imagePromises = [];
        const validImages = [];

        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && isImage(zipEntry.name)) {
                const promise = zipEntry.async('blob').then(async (blob) => {
                    const exifData = await getExifData(blob);
                    if (exifData && exifData.lat && exifData.lng) {
                        validImages.push({
                            name: zipEntry.name,
                            blob: blob,
                            lat: exifData.lat,
                            lng: exifData.lng,
                            alt: exifData.alt || 0
                        });
                    }
                });
                imagePromises.push(promise);
            }
        });

        await Promise.all(imagePromises);

        if (validImages.length === 0) {
            statusDiv.textContent = 'No images with GPS data found.';
            statusDiv.style.color = 'var(--error-color)';
            return;
        }

        // Calculate Center
        const center = getCenter(validImages);

        // Set global center for projection
        window.centerLat = center.lat;
        window.centerLng = center.lng;
        window.centerMercator = latLonToMercator(center.lat, center.lng);

        // Load Map Tiles
        await loadMapTiles(center.lat, center.lng);

        // Convert to Cartesian (Web Mercator)
        validImages.forEach(img => {
            const pos = gpsToCartesian(img.lat, img.lng, img.alt);
            createPoint(pos, img);
        });

        statusDiv.textContent = `Visualized ${validImages.length} images in 3D with Map Overlay.`;
        statusDiv.style.color = 'var(--success-color)';

    } catch (err) {
        console.error(err);
        statusDiv.textContent = 'Error processing file: ' + err.message;
        statusDiv.style.color = 'var(--error-color)';
    }
});

function createPoint(pos, imgData) {
    const geometry = new THREE.SphereGeometry(5, 32, 32);
    const material = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.3, metalness: 0.8 });
    const sphere = new THREE.Mesh(geometry, material);

    sphere.position.set(pos.x, pos.y, pos.z);

    // Add user data for interaction later
    sphere.userData = { ...imgData };

    scene.add(sphere);
    points.push(sphere);
}

function getCenter(images) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    images.forEach(img => {
        minLat = Math.min(minLat, img.lat);
        maxLat = Math.max(maxLat, img.lat);
        minLng = Math.min(minLng, img.lng);
        maxLng = Math.max(maxLng, img.lng);
    });

    return {
        lat: (minLat + maxLat) / 2,
        lng: (minLng + maxLng) / 2
    };
}

// Web Mercator Projection
const R = 6378137; // Earth radius in meters (WGS84 major axis)

function latLonToMercator(lat, lon) {
    const x = R * THREE.MathUtils.degToRad(lon);
    const y = R * Math.log(Math.tan(Math.PI / 4 + THREE.MathUtils.degToRad(lat) / 2));
    return { x, y };
}

function gpsToCartesian(lat, lng, alt) {
    const mercator = latLonToMercator(lat, lng);

    // Relative to center
    const x = mercator.x - window.centerMercator.x;
    const z = -(mercator.y - window.centerMercator.y); // Invert Y for 3D Z
    const y = alt;

    return { x, y, z };
}

// Map Tile Loading
async function loadMapTiles(lat, lng) {
    // Clear existing tiles
    mapTiles.forEach(tile => scene.remove(tile));
    mapTiles = [];

    const zoom = 19; // High zoom for detail
    const tileX = long2tile(lng, zoom);
    const tileY = lat2tile(lat, zoom);

    // Load a 3x3 grid centered on the data
    const radius = 2;
    const textureLoader = new THREE.TextureLoader();

    for (let x = tileX - radius; x <= tileX + radius; x++) {
        for (let y = tileY - radius; y <= tileY + radius; y++) {
            const url = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;

            // Calculate tile position in 3D space
            // Tile size in meters at this zoom
            const tileSizeMeters = (2 * Math.PI * R) / Math.pow(2, zoom); // Earth circumference / 2^zoom

            // Tile center in Mercator coordinates
            const tileCenterMercatorX = ((x + 0.5) / Math.pow(2, zoom)) * (2 * Math.PI * R) - (Math.PI * R);
            const tileCenterMercatorY = (Math.PI * R) - ((y + 0.5) / Math.pow(2, zoom)) * (2 * Math.PI * R);

            const posX = tileCenterMercatorX - window.centerMercator.x;
            const posZ = -(tileCenterMercatorY - window.centerMercator.y);

            textureLoader.load(url, (texture) => {
                const geometry = new THREE.PlaneGeometry(tileSizeMeters, tileSizeMeters);
                const material = new THREE.MeshBasicMaterial({ map: texture });
                const plane = new THREE.Mesh(geometry, material);

                plane.rotation.x = -Math.PI / 2; // Rotate to be flat on ground
                plane.position.set(posX, -0.5, posZ); // Slightly below 0 to avoid z-fighting

                // Check initial toggle state
                const toggle = document.getElementById('mapToggle');
                if (toggle) {
                    plane.visible = toggle.checked;
                }

                scene.add(plane);
                mapTiles.push(plane);
            });
        }
    }
}

// Map Toggle Event Listener
const mapToggle = document.getElementById('mapToggle');
if (mapToggle) {
    mapToggle.addEventListener('change', (e) => {
        const isVisible = e.target.checked;
        mapTiles.forEach(tile => {
            tile.visible = isVisible;
        });
    });
}

function long2tile(lon, zoom) {
    return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
}

function lat2tile(lat, zoom) {
    return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
}

function isImage(filename) {
    return /\.(jpg|jpeg|png|heic)$/i.test(filename);
}

function getExifData(blob) {
    return new Promise((resolve) => {
        EXIF.getData(blob, function () {
            const lat = EXIF.getTag(this, "GPSLatitude");
            const latRef = EXIF.getTag(this, "GPSLatitudeRef");
            const lng = EXIF.getTag(this, "GPSLongitude");
            const lngRef = EXIF.getTag(this, "GPSLongitudeRef");
            const alt = EXIF.getTag(this, "GPSAltitude");
            const altRef = EXIF.getTag(this, "GPSAltitudeRef");

            if (lat && latRef && lng && lngRef) {
                const decimalLat = convertDMSToDD(lat, latRef);
                const decimalLng = convertDMSToDD(lng, lngRef);

                let altitude = 0;
                if (alt !== undefined && alt !== null) {
                    altitude = parseFloat(alt);
                    if (altRef === 1) altitude = -altitude;
                }

                resolve({
                    lat: decimalLat,
                    lng: decimalLng,
                    alt: altitude
                });
            } else {
                resolve(null);
            }
        });
    });
}

function convertDMSToDD(dms, ref) {
    let dd = dms[0] + dms[1] / 60 + dms[2] / 3600;
    if (ref === "S" || ref === "W") {
        dd = dd * -1;
    }
    return dd;
}

class Scene {
    constructor() {

    }

    init() {
        let dom = document.getElementById('center');

        let w = Math.floor(dom.clientWidth);
        let h = Math.floor(dom.clientHeight);

        let scene = new THREE.Scene();
        let camera = new THREE.PerspectiveCamera( 75, w / h, 0.1, 1000 );

        let directionalLight = new THREE.DirectionalLight( 0xffffff, 1.0 );
        scene.add( directionalLight );
        scene.add(new THREE.AmbientLight( 0x888888 ));

        let renderer = new THREE.WebGLRenderer();
        renderer.setSize( w, h );
        dom.appendChild( renderer.domElement );
        
        let cursor = createCube(0x00ff00);
        cursor.position.set(64,0,64);
        scene.add( cursor );

        cameraLookAt(camera, 132,77,132, 0,1,0, 64,32,64);

        var controls = new THREE.OrbitControls(camera, renderer.domElement);
        //controls.target.set(64,32,64);
        controls.target.set(64,0,64);
        controls.update();

        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.controls = controls;

        SELECTION.init(renderer.domElement);

        let obs = new ResizeObserver(() => {
            //console.log(dom.clientWidth + " " + dom.clientHeight);
            renderer.setSize(dom.clientWidth, dom.clientHeight);
        });
        obs.observe(dom);

        animate();
    }
    
    setTerrain(terrain) {
        if (this.loaded_terrain) {
            this.loaded_terrain.removeFromScene();
        }
        terrain.addToScene(this.scene);
        this.loaded_terrain = terrain;
    }

    frame() {
        this.renderer.render( this.scene, this.camera );
    }
}

function cameraLookAt(camera, px, py, pz, ux, uy, uz, lx, ly, lz) {
    camera.position.set(px, py, pz);
    camera.up = new THREE.Vector3(ux,uy,uz);
    camera.lookAt(lx,ly,lz);
}

function createCube(color) {
    var geometry = new THREE.BoxGeometry( 1, 1, 1 );
    var material = new THREE.MeshBasicMaterial( { wireframe: true, color: color } );
    return new THREE.Mesh( geometry, material );
}

var SCENE = new Scene();

function animate() {
    requestAnimationFrame( animate );
	SCENE.frame();
}